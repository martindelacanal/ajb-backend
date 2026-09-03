/**
 * Plantillas de contenido inicial del módulo Olimpiadas.
 *
 * Se usan en dos lugares:
 *  - scripts/migrar-olimpiadas-v2.js: siembra tramos y secciones en las olimpiadas ya existentes.
 *  - api/routes/olimpiadas.js: al crear una olimpiada nueva, la deja con los tramos de bonos y
 *    las secciones informativas de base para que el admin sólo tenga que ajustar textos.
 *
 * Los textos provienen del sistema anterior de la AJB (Olimpiadas 2024, Miramar) y son
 * totalmente editables desde el back-office: acá sólo viven como punto de partida.
 */

// Bonos contribución por edad del acompañante. `edad_hasta` NULL = sin tope (18 años o más).
// El afiliado participante NO usa esta tabla: paga `olimpiada.bonos_afiliado` (8 por defecto).
const TRAMOS_BONOS_INICIALES = Object.freeze([
  { edad_desde: 0, edad_hasta: 2, bonos: 0, etiqueta: "0 a 2 años" },
  { edad_desde: 3, edad_hasta: 4, bonos: 2, etiqueta: "3 y 4 años" },
  { edad_desde: 5, edad_hasta: 6, bonos: 3, etiqueta: "5 y 6 años" },
  { edad_desde: 7, edad_hasta: 8, bonos: 4, etiqueta: "7 y 8 años" },
  { edad_desde: 9, edad_hasta: 10, bonos: 5, etiqueta: "9 y 10 años" },
  { edad_desde: 11, edad_hasta: 12, bonos: 6, etiqueta: "11 y 12 años" },
  { edad_desde: 13, edad_hasta: 15, bonos: 7, etiqueta: "13 a 15 años" },
  { edad_desde: 16, edad_hasta: 17, bonos: 8, etiqueta: "16 y 17 años" },
  { edad_desde: 18, edad_hasta: null, bonos: 11, etiqueta: "18 años o más (invitado)" },
]);

const SECCIONES_INICIALES = Object.freeze([
  {
    clave: "regulaciones_generales",
    ubicacion: "REGLAMENTO",
    titulo: "Regulaciones generales",
    orden: 1,
    contenido: [
      "Lxs atletas podrán participar sólo de una disciplina.",
      "Para poder ser consideradx atleta se deberá tener cotización activa a la AJB o haber demostrado nueva afiliación a la Subsecretaría de Deportes Provincial.",
      "La autoridad dentro del campo de juego es la/el árbitra/o o juez/a, si lo hubiera.",
      "Cada disciplina posee un reglamento general y un reglamento particular que se especifica para nuestro evento, y éste último prevalecerá sobre el primero. La resolución de cualquier cuestión no contemplada recaerá en la persona veedora.",
      "Durante la competencia, lxs deportistas deberán presentarse media hora antes de jugar ante el veedor de la competencia para registrarse y poder competir.",
      "Las departamentales que se hayan inscripto y después no acudan a participar en las finales quedarán excluidas de poder participar en los próximos juegos en dicha disciplina, salvo cuestiones de fuerza mayor debidamente justificadas ante la Subsecretaría de Deportes de la AJB Provincial.",
    ].join("\n\n"),
  },
  {
    clave: "gafete",
    ubicacion: "REGLAMENTO",
    titulo: "Gafete",
    orden: 2,
    contenido: [
      "El gafete es el documento por excelencia del evento. Quien posea la credencial tendrá derecho a ingresar a los predios donde se desarrollen todas las disciplinas, como así también al camping, a competir deportivamente y a participar de todo el cronograma de actividades extra deportivas, almuerzos y cenas.",
      "Se entregará el día pactado como inaugural de las Olimpíadas ante una mesa de acreditación en el camping y durante todo el día.",
      "Las personas deberán presentarse con DNI y carnet de afiliación en cualquiera de sus formatos; se aconseja poseer credencial de la obra social que corresponda a cada caso. El veedor constatará la identidad de la persona con el documento y que la foto del gafete se corresponda. Hecho esto, se entregará el gafete y a partir de allí no se requerirá ningún otro documento como acreditación.",
      "Los gafetes de lxs acompañantes de afiliadxs, responsables departamentales y choferes se entregarán todos juntos al representante departamental, sin necesidad de constatación de identidad.",
    ].join("\n\n"),
  },
  {
    clave: "trofeo_departamental",
    ubicacion: "REGLAMENTO",
    titulo: "Trofeo departamental y sistema de puntos",
    orden: 3,
    contenido: [
      "A partir de las Olimpiadas Judiciales 2023 se otorga a la departamental ganadora el trofeo «Guardiana Sindical Bonaerense», que representa la dedicación y la tenacidad en la lucha sindical y enaltece los valores históricos de solidaridad y justicia de la Asociación Judicial Bonaerense. La departamental campeona lo enarbola durante el resto de su estadía y recibe una copia para exhibirla en su sede; en la edición siguiente, el campeón anterior lo entrega al nuevo campeón olímpico.",
      "Se siguen entregando además los trofeos de oro, plata, bronce y cobre de cada olimpiada en particular.",
      "Sistema de puntos (tomado del segundo sistema de puntuación del Comité Olímpico Internacional): Oro 10 puntos, Plata 5 puntos, Bronce 4 puntos. Cada participante que compita por más de una presea suma puntaje por la mejor de sus obtenciones y no por todas las que logre.",
      "Interdepartamentalidad: los puntos de las disciplinas en las que participan compañerxs de más de una departamental se consideran interdepartamentales y, en caso de acceder al medallero, se dividen en partes iguales.",
    ].join("\n\n"),
  },
  {
    clave: "protocolo_medico",
    ubicacion: "DATOS_UTILES",
    titulo: "Protocolo de atención médica",
    orden: 1,
    contenido: [
      "Ante la necesidad de atención médica, lxs veedores de cada disciplina deberán comunicarse con las personas responsables de coordinar el servicio de ambulancias (ver contactos de esta sección). Durante la noche, cuando las delegaciones estén en los hoteles, lxs responsables departamentales deberán comunicarse con algunx de ellxs para solicitar el envío de la ambulancia al hotel.",
      "Recuerden que, en caso de tener que movilizar a compañeros en ambulancia, deben ser acompañados por un responsable departamental.",
    ].join("\n\n"),
  },
  {
    clave: "bases_condiciones_bono",
    ubicacion: "BONOS",
    titulo: "Bases y condiciones del bono contribución",
    orden: 1,
    contenido: [
      "El bono lleva impreso un número de cuatro cifras con el que el titular participa del sorteo. Los premios se asignan según los números sorteados en la fecha, hora y quiniela indicadas en esta sección.",
      "En caso de que queden premios vacantes, ya sea por repetirse algún número de los sorteados o por no haberse vendido el bono correspondiente, el premio quedará vacante.",
      "Las estadías son válidas únicamente para ser utilizadas por el/la ganador/a del sorteo. Los premios NO incluyen traslados (ni aéreos ni terrestres) hasta los destinos. El ganador deberá respetar todas las normativas y reglamentaciones vigentes del alojamiento dispuesto por cada complejo.",
      "El mero hecho de participar en el sorteo implica que el/la ganador/a acepta íntegramente la totalidad de las condiciones expresadas en estas bases y condiciones.",
      "El derecho adquirido por el titular del bono que resulte favorecido en cualquiera de los premios caduca indefectiblemente a los sesenta (60) días de la fecha del sorteo, plazo en el que deberá efectuar la acreditación correspondiente.",
    ].join("\n\n"),
  },
]);

// Categorías de inscripto sugeridas (coinciden con olimpiada_disciplina_tipo del seed original).
const CATEGORIAS_INSCRIPTO = Object.freeze(["Atleta", "Coordinación", "Cultura", "Organización", "Prensa", "Acompañante"]);

module.exports = Object.freeze({
  TRAMOS_BONOS_INICIALES,
  SECCIONES_INICIALES,
  CATEGORIAS_INSCRIPTO,
});
