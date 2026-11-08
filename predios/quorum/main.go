// The local helper owns only Raft's journal and a small compare-and-swap
// register. Commercial data stays in the application's encrypted snapshots.
package main

import (
	"bufio"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/hashicorp/raft"
	bolt "github.com/hashicorp/raft-boltdb/v2"
)

const limit = 1024 * 1024
const wait = 2 * time.Second

type config struct {
	ID, Listen, Advertise, Directory, Secret, LocalKey string
	Bootstrap                                          []peer
}

type peer struct{ ID, Address string }

type entry struct {
	Expected uint64
	Data     json.RawMessage
}

type register struct {
	Version uint64          `json:"version"`
	Data    json.RawMessage `json:"data"`
}

type machine struct {
	mu sync.RWMutex
	register
}

func (m *machine) current() register {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.register
}

func (m *machine) Apply(l *raft.Log) any {
	var e entry
	if json.Unmarshal(l.Data, &e) != nil || len(e.Data) == 0 {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if e.Expected != m.Version {
		return false
	}
	m.register = register{Version: l.Index, Data: e.Data}
	return true
}

type saved register

func (s saved) Persist(sink raft.SnapshotSink) error {
	if err := json.NewEncoder(sink).Encode(s); err != nil {
		_ = sink.Cancel()
		return err
	}
	return sink.Close()
}

func (s saved) Release() {}

func (m *machine) Snapshot() (raft.FSMSnapshot, error) { return saved(m.current()), nil }

func (m *machine) Restore(r io.ReadCloser) error {
	defer r.Close()
	var state register
	if err := json.NewDecoder(io.LimitReader(r, limit)).Decode(&state); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.register = state
	return nil
}

type stream struct {
	net.Listener
	address net.Addr
	client  *tls.Config
}

func (s stream) Addr() net.Addr { return s.address }

func (s stream) Dial(address raft.ServerAddress, timeout time.Duration) (net.Conn, error) {
	return tls.DialWithDialer(&net.Dialer{Timeout: timeout}, "tcp", string(address), s.client)
}

type advertised string

func (a advertised) Network() string { return "tcp" }
func (a advertised) String() string  { return string(a) }

// Every enrolled machine already possesses the group's random transport secret.
// Deriving this private CA from it authenticates the Raft streams in both
// directions without trusting Windows' certificate store or opening the API.
func secureStream(c config, secret []byte) (stream, error) {
	seed := sha256.Sum256(append([]byte("ajb-predio-raft-ca\x00"), secret...))
	caKey := ed25519.NewKeyFromSeed(seed[:])
	notBefore := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	notAfter := time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC)
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: notBefore, NotAfter: notAfter,
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, caKey.Public(), caKey)
	if err != nil {
		return stream{}, err
	}
	root, err := x509.ParseCertificate(caDER)
	if err != nil {
		return stream{}, err
	}
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return stream{}, err
	}
	number, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return stream{}, err
	}
	cert := &x509.Certificate{SerialNumber: number, NotBefore: notBefore, NotAfter: notAfter,
		DNSNames: []string{"raft.predio.ajb"}, KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth}}
	der, err := x509.CreateCertificate(rand.Reader, cert, root, pub, caKey)
	if err != nil {
		return stream{}, err
	}
	pool := x509.NewCertPool()
	pool.AddCert(root)
	certs := []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}
	server := &tls.Config{MinVersion: tls.VersionTLS13, Certificates: certs, ClientCAs: pool, ClientAuth: tls.RequireAndVerifyClientCert}
	client := &tls.Config{MinVersion: tls.VersionTLS13, Certificates: certs, RootCAs: pool, ServerName: "raft.predio.ajb"}
	listener, err := tls.Listen("tcp", c.Listen, server)
	return stream{Listener: listener, client: client, address: advertised(c.Advertise)}, err
}

type consensus struct {
	raft *raft.Raft
	fsm  *machine
	mu   sync.Mutex
}

func (c *consensus) info() (uint64, raft.ServerID, raft.ConfigurationFuture, error) {
	before := c.raft.Stats()["term"]
	if err := c.raft.Barrier(wait).Error(); err != nil {
		return 0, "", nil, err
	}
	term, err := strconv.ParseUint(before, 10, 64)
	if err != nil || c.raft.State() != raft.Leader || before != c.raft.Stats()["term"] {
		return 0, "", nil, raft.ErrNotLeader
	}
	_, leader := c.raft.LeaderWithID()
	peers := c.raft.GetConfiguration()
	return term, leader, peers, peers.Error()
}

func (c *consensus) serve(key string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+key)) != 1 {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method == "GET" && r.URL.Path == "/local" {
			_ = json.NewEncoder(w).Encode(map[string]any{"version": c.fsm.current().Version})
			return
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		term, leader, peers, err := c.info()
		if err != nil {
			_, id := c.raft.LeaderWithID()
			w.WriteHeader(http.StatusServiceUnavailable)
			_ = json.NewEncoder(w).Encode(map[string]any{"leader": id})
			return
		}
		current := c.fsm.current()
		switch r.Method + " " + r.URL.Path {
		case "GET /state":
			_ = json.NewEncoder(w).Encode(map[string]any{"register": current, "term": term, "leader": leader,
				"members": peers.Configuration().Servers, "configuration": peers.Index()})
		case "POST /state":
			var request struct {
				entry
				Term, Configuration uint64
			}
			if json.NewDecoder(http.MaxBytesReader(w, r.Body, limit)).Decode(&request) != nil || len(request.Data) == 0 {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			if request.Term != term || request.Configuration != peers.Index() || current.Version != request.Expected {
				w.WriteHeader(http.StatusConflict)
				return
			}
			data, _ := json.Marshal(request.entry)
			future := c.raft.Apply(data, wait)
			if future.Error() != nil || future.Response() != true || c.raft.State() != raft.Leader {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			_ = json.NewEncoder(w).Encode(c.fsm.current())
		case "POST /member":
			var request struct {
				peer
				Expected, Term, Configuration uint64
				Voter                         bool
			}
			if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&request) != nil || !identifier.MatchString(request.ID) {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			if _, _, err := net.SplitHostPort(request.Address); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			if request.Term != term || request.Configuration != peers.Index() || request.Expected != current.Version {
				w.WriteHeader(http.StatusConflict)
				return
			}
			var change raft.IndexFuture
			if request.Voter {
				change = c.raft.AddVoter(raft.ServerID(request.ID), raft.ServerAddress(request.Address), peers.Index(), wait)
			} else {
				change = c.raft.AddNonvoter(raft.ServerID(request.ID), raft.ServerAddress(request.Address), peers.Index(), wait)
			}
			if err := change.Error(); err != nil {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			_ = json.NewEncoder(w).Encode(true)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
}

var identifier = regexp.MustCompile(`^[a-f0-9]{64}$`)

func run(c config) error {
	secret, err := hex.DecodeString(c.Secret)
	if err != nil || len(secret) != 32 || !identifier.MatchString(c.LocalKey) || !identifier.MatchString(c.ID) {
		return errors.New("invalid consensus identity")
	}
	if err = os.MkdirAll(c.Directory, 0700); err != nil {
		return err
	}
	journal := filepath.Join(c.Directory, "raft.db")
	marker := c.Directory + ".initialized"
	_, err = os.Stat(marker)
	initialized := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if _, err := os.Stat(journal); initialized && err != nil {
		return errors.New("the existing coordination journal must be recovered before restarting this member")
	}
	store, err := bolt.NewBoltStore(journal)
	if err != nil {
		return err
	}
	defer store.Close()
	snapshots, err := raft.NewFileSnapshotStore(c.Directory, 2, os.Stderr)
	if err != nil {
		return err
	}
	secure, err := secureStream(c, secret)
	if err != nil {
		return err
	}
	transport := raft.NewNetworkTransport(secure, 2, wait, os.Stderr)
	defer transport.Close()
	settings := raft.DefaultConfig()
	settings.LocalID = raft.ServerID(c.ID)
	settings.LogOutput = os.Stderr
	settings.TrailingLogs = 128
	settings.SnapshotThreshold = 128
	existing, err := raft.HasExistingState(store, store, snapshots)
	if err != nil {
		return err
	}
	if !existing && len(c.Bootstrap) > 0 {
		if initialized || len(c.Bootstrap) < 3 || len(c.Bootstrap) > 20 {
			return errors.New("invalid initial voting configuration or missing journal")
		}
		cluster := raft.Configuration{}
		for _, p := range c.Bootstrap {
			if !identifier.MatchString(p.ID) {
				return errors.New("invalid bootstrap member")
			}
			cluster.Servers = append(cluster.Servers, raft.Server{ID: raft.ServerID(p.ID), Address: raft.ServerAddress(p.Address), Suffrage: raft.Voter})
		}
		if err := raft.BootstrapCluster(settings, store, store, snapshots, transport, cluster); err != nil {
			return err
		}
	}
	if !initialized {
		f, err := os.OpenFile(marker, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		err = f.Sync()
		_ = f.Close()
		if err != nil {
			return err
		}
	}
	fsm := &machine{}
	instance, err := raft.NewRaft(settings, fsm, store, store, snapshots, transport)
	if err != nil {
		return err
	}
	defer func() { _ = instance.Shutdown().Error() }()
	local, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer local.Close()
	fmt.Println(local.Addr().String())
	server := http.Server{Handler: (&consensus{raft: instance, fsm: fsm}).serve(c.LocalKey), ReadHeaderTimeout: wait}
	return server.Serve(local)
}

func main() {
	parent := bufio.NewReader(io.LimitReader(os.Stdin, limit))
	data, err := parent.ReadBytes('\n')
	var c config
	if err != nil || json.Unmarshal(data, &c) != nil {
		log.Fatal("invalid configuration")
	}
	// The child must not retain the Raft port or journal after Node has exited.
	go func() {
		_, _ = io.Copy(io.Discard, parent)
		os.Exit(0)
	}()
	if err := run(c); err != nil {
		log.Fatal(err)
	}
}
