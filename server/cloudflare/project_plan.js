// CHE Project Intelligence (owner, 2026-10-20): turn any idea into a structured, costed, visual plan.
// One universal layer over the existing systems: the request is classified into a project type, which
// picks its planning structure (bill of materials, feature list, asset list, resource plan or work
// breakdown). It is then decomposed into systems and items with dependencies, sizes, complexity and
// cost/effort ranges per tier, checked by a safety layer, and given one public source when one could be read.
// Pure except `researchSource` (one public read) and `savePlan` (DO storage + the Brain).
// Every figure is a labeled estimate with its method; nothing here is presented as a quote or a fact.

import { BRAIN_REGIONS } from './brain_store.js';

export const PLAN_VERSION = 1;
export const PLAN_SOURCE = 'che_project_plan';
const AS_OF = '2026-10';
const METHOD = `CHE category template, US dollars, ${AS_OF} market ranges for one build; not supplier quotes`;

// ── Item templates ──────────────────────────────────────────────────────────────────────────────
// I(id, name, system, purpose, spec): spec.s size or scope 1-5, spec.x complexity 1-5, spec.d needs,
// spec.c/b/p cheapest/balanced/premium [low, high] USD, spec.h effort hours [low, high],
// spec.o the option at each tier, spec.opt optional, spec.per 'once' | 'unit' | 'month', spec.k kind.
const I = (id, name, system, purpose, spec) => ({ id, name, system, purpose, ...spec });
const parts = (list) => list.map((item) => ({ k: 'part', ...item }));

const WEARABLE = parts([
  I('frame', 'Exoskeleton frame and limb links', 'Structure', 'Carries the load along the body', { s: 5, x: 3, c: [150, 400], b: [600, 1500], p: [3000, 9000], h: [40, 120], o: ['aluminium extrusion and PETG prints', 'CNC aluminium links', 'carbon-fibre tube and machined titanium joints'] }),
  I('joints', 'Joint bearings and hinges', 'Structure', 'Lets each limb pivot where the body does', { s: 2, x: 3, d: ['frame'], c: [60, 150], b: [200, 500], p: [800, 2000], h: [10, 30], o: ['skate bearings and printed hinges', 'flanged bearings and shoulder bolts', 'cross-roller bearings'] }),
  I('actuators', 'Joint actuators (elbows, knees, hips)', 'Actuation', 'Adds assistive force at the joints', { s: 3, x: 5, d: ['frame', 'joints'], c: [200, 600], b: [1500, 4000], p: [8000, 25000], h: [60, 200], o: ['high-torque hobby servos, light assist only', 'BLDC motors with planetary gearboxes', 'quasi-direct-drive actuators with torque sensing'] }),
  I('drivers', 'Motor drivers', 'Actuation', 'Power and control each actuator', { s: 2, x: 4, d: ['actuators', 'battery'], c: [50, 150], b: [300, 800], p: [1500, 4000], h: [10, 40], o: ['hobby servo boards', 'field-oriented BLDC drivers', 'industrial servo drives'] }),
  I('battery', 'Battery pack and battery management', 'Power', 'Stores the energy; the BMS keeps cells safe', { s: 3, x: 4, c: [120, 300], b: [400, 1000], p: [1500, 4000], h: [10, 40], o: ['power-tool packs with adapters', 'custom Li-ion pack with a BMS', 'high-density cells, certified BMS and enclosure'] }),
  I('controller', 'Main controller', 'Control', 'Reads the sensors and commands the joints', { s: 2, x: 4, d: ['drivers', 'sensors'], c: [30, 80], b: [150, 400], p: [600, 1500], h: [10, 30], o: ['ESP32 or Teensy microcontroller', 'single-board computer plus a real-time microcontroller', 'Jetson-class compute with a real-time co-processor'] }),
  I('sensors', 'Sensors (IMU, joint encoders, force)', 'Sensing', 'Measures posture, joint angles and load', { s: 1, x: 4, c: [40, 120], b: [200, 600], p: [1000, 3000], h: [10, 40], o: ['hobby IMU and potentiometers', 'magnetic encoders and load cells', 'industrial encoders and six-axis force sensors'] }),
  I('estop', 'Emergency stop and joint limits', 'Safety', 'Cuts power and keeps joints inside human range', { s: 1, x: 3, d: ['controller', 'drivers'], c: [20, 60], b: [80, 200], p: [300, 800], h: [10, 40], o: ['latching stop switch and software limits', 'hardware stop relay plus mechanical end stops', 'certified safety relay with redundant limits'] }),
  I('shell', 'Armor shell panels', 'Shell', 'The look; protects the parts underneath', { s: 4, x: 2, d: ['frame'], c: [60, 200], b: [300, 900], p: [2000, 8000], h: [30, 120], o: ['EVA foam', '3D-printed PETG or ABS, painted', 'carbon or fibreglass layup, automotive paint'] }),
  I('harness', 'Straps, harness and padding', 'Structure', 'Holds the frame to the body comfortably', { s: 3, x: 2, d: ['frame'], c: [40, 100], b: [150, 400], p: [600, 1500], h: [8, 24], o: ['webbing and foam', 'climbing-grade harness and molded pads', 'custom-fitted medical-grade cuffs'] }),
  I('wiring', 'Wiring harness and connectors', 'Integration', 'Connects power and signals', { s: 1, x: 3, d: ['battery', 'drivers', 'controller'], c: [40, 100], b: [150, 350], p: [500, 1200], h: [10, 30], o: ['hobby wire and connectors', 'locking connectors and sleeving', 'aviation-grade harness'] }),
  I('hud', 'Helmet display (HUD)', 'Control', 'Shows status inside the helmet', { s: 2, x: 4, d: ['controller'], opt: true, c: [60, 200], b: [400, 1200], p: [2000, 6000], h: [20, 80], o: ['a phone or small OLED', 'AR glasses module', 'custom waveguide display'] }),
  I('cad', 'CAD, body measurements and fit', 'Integration', 'Sizes everything to the wearer', { k: 'work', s: 3, x: 3, c: [0, 100], b: [500, 2000], p: [4000, 12000], h: [40, 160], o: ['free CAD, your own measurements', 'paid CAD and a fitting session', 'professional design studio and 3D body scan'] }),
  I('firmware', 'Control firmware and tuning', 'Control', 'Makes the joints move safely with the wearer', { k: 'work', s: 4, x: 5, d: ['controller', 'sensors'], c: [0, 0], b: [1000, 4000], p: [8000, 25000], h: [80, 300], o: ['you write it', 'a freelance embedded engineer', 'a robotics firm'] }),
  I('testing', 'Bench and fit testing', 'Safety', 'Proves it is safe before anyone wears it powered', { k: 'work', s: 3, x: 3, d: ['estop', 'firmware', 'shell', 'harness'], c: [50, 200], b: [500, 1500], p: [3000, 10000], h: [30, 120], o: ['bench tests with a mannequin', 'instrumented tests and a spotter', 'lab testing to exoskeleton standards'] }),
]);

const ELECTRONICS = parts([
  I('requirements', 'Requirements and concept', 'Design', 'What it must do, its size and its budget', { k: 'work', s: 2, x: 2, c: [0, 0], b: [200, 800], p: [2000, 6000], h: [8, 40], o: ['your own notes', 'a paid design review', 'an industrial design studio'] }),
  I('chassis', 'Chassis or frame', 'Structure', 'Holds every part in place', { s: 4, x: 3, d: ['requirements'], c: [30, 120], b: [150, 500], p: [800, 3000], h: [10, 40], o: ['3D-printed PLA', 'CNC aluminium or nylon prints', 'machined aluminium or carbon'] }),
  I('motors', 'Motors or actuators', 'Actuation', 'Moves it', { s: 3, x: 4, d: ['chassis'], opt: false, c: [30, 120], b: [150, 500], p: [800, 3000], h: [8, 30], o: ['hobby DC motors or servos', 'brushless motors with encoders', 'precision servo actuators'] }),
  I('drivers', 'Motor drivers', 'Actuation', 'Power the motors under control', { s: 2, x: 3, d: ['motors', 'battery'], c: [15, 50], b: [60, 200], p: [300, 900], h: [4, 16], o: ['H-bridge boards', 'BLDC driver boards', 'industrial drives'] }),
  I('battery', 'Battery and power regulation', 'Power', 'Stores and regulates energy', { s: 3, x: 3, c: [25, 80], b: [100, 300], p: [500, 1500], h: [4, 20], o: ['AA packs or a USB power bank', 'Li-ion pack with BMS and regulators', 'custom pack with certified BMS'] }),
  I('controller', 'Controller board', 'Control', 'Runs the logic', { s: 1, x: 3, d: ['sensors'], c: [10, 40], b: [50, 150], p: [300, 900], h: [4, 16], o: ['Arduino or ESP32', 'Raspberry Pi or STM32', 'custom PCB with an industrial MCU'] }),
  I('sensors', 'Sensors', 'Sensing', 'Lets it see, feel or measure', { s: 1, x: 3, c: [15, 60], b: [80, 300], p: [500, 2000], h: [4, 20], o: ['hobby sensor kit', 'quality IMU, distance and camera modules', 'lidar or industrial sensors'] }),
  I('pcb', 'Wiring or custom circuit board', 'Integration', 'Connects everything', { s: 1, x: 3, d: ['controller', 'drivers', 'battery'], c: [10, 40], b: [80, 300], p: [500, 2000], h: [6, 30], o: ['breadboard and jumper wires', 'a custom two-layer PCB', 'a multi-layer PCB, assembled'] }),
  I('enclosure', 'Enclosure', 'Structure', 'Protects the electronics', { s: 3, x: 2, d: ['pcb'], c: [10, 40], b: [60, 200], p: [400, 3000], h: [6, 24], o: ['3D print', 'printed and finished, or a stock enclosure', 'injection-molded (tooling extra)'] }),
  I('firmware', 'Firmware and software', 'Control', 'Makes it behave', { k: 'work', s: 3, x: 4, d: ['controller', 'sensors'], c: [0, 0], b: [800, 4000], p: [6000, 20000], h: [30, 200], o: ['you write it', 'a freelance developer', 'an engineering firm'] }),
  I('app', 'Phone app or connectivity', 'Control', 'Control or data from a phone', { k: 'work', s: 3, x: 3, d: ['firmware'], opt: true, c: [0, 0], b: [1500, 6000], p: [10000, 40000], h: [40, 200], o: ['Bluetooth via an existing app', 'a simple custom app', 'a polished app with cloud'] }),
  I('testing', 'Testing and certification', 'Safety', 'Proves it works and is safe to sell', { k: 'work', s: 3, x: 3, d: ['enclosure', 'firmware'], c: [0, 100], b: [500, 3000], p: [5000, 25000], h: [10, 60], o: ['your own tests', 'pre-compliance testing', 'FCC/CE/UL certification'] }),
]);

const PRODUCT = parts([
  I('concept', 'Concept, sketches and requirements', 'Design', 'What it is, who it is for, the price target', { k: 'work', s: 2, x: 2, c: [0, 0], b: [200, 1000], p: [3000, 10000], h: [8, 40], o: ['your own sketches', 'a freelance product designer', 'an industrial design studio'] }),
  I('cad', 'CAD model and drawings', 'Design', 'Exact geometry for prototypes and factories', { k: 'work', s: 3, x: 3, d: ['concept'], c: [0, 100], b: [500, 2000], p: [3000, 12000], h: [20, 80], o: ['free CAD, done yourself', 'a freelance CAD designer', 'a design-for-manufacture engineer'] }),
  I('body', 'Main body or structure', 'Structure', 'The largest part, which everything attaches to', { s: 5, x: 3, d: ['cad'], c: [20, 150], b: [100, 600], p: [500, 3000], h: [10, 40], o: ['3D print or hand-built', 'CNC or sheet metal', 'machined or premium material'] }),
  I('components', 'Secondary parts and mechanisms', 'Structure', 'Moving or functional parts', { s: 3, x: 3, d: ['body'], c: [20, 120], b: [100, 500], p: [500, 2500], h: [10, 40], o: ['off-the-shelf parts', 'custom machined parts', 'precision parts'] }),
  I('hardware', 'Fasteners and hardware', 'Assembly', 'Screws, hinges, inserts', { s: 1, x: 1, d: ['body'], c: [5, 30], b: [20, 80], p: [80, 300], h: [1, 4], o: ['hardware-store fasteners', 'stainless hardware', 'custom or titanium hardware'] }),
  I('finish', 'Finish and coating', 'Finish', 'Look, feel and durability', { s: 3, x: 2, d: ['body', 'components'], c: [10, 50], b: [60, 300], p: [300, 1500], h: [4, 20], o: ['paint or oil', 'powder coat or anodizing', 'premium finish or plating'] }),
  I('prototype', 'Working prototype build', 'Prototype', 'Assemble and test the first one', { k: 'work', s: 3, x: 3, d: ['finish', 'hardware'], c: [0, 100], b: [300, 1500], p: [2000, 8000], h: [10, 60], o: ['you build it', 'a prototype shop', 'a full engineering prototype'] }),
  I('testing', 'Testing and compliance', 'Prototype', 'Safety, durability and the rules for its market', { k: 'work', s: 3, x: 3, d: ['prototype'], c: [0, 100], b: [500, 3000], p: [3000, 20000], h: [8, 40], o: ['your own use tests', 'lab durability tests', 'certification for its category'] }),
  I('packaging', 'Packaging', 'Launch', 'Protects it and sells it', { s: 3, x: 1, d: ['prototype'], per: 'unit', c: [1, 3], b: [3, 8], p: [8, 25], h: [4, 20], o: ['stock box and label', 'custom printed box', 'premium rigid box with inserts'] }),
  I('tooling', 'Production tooling', 'Production', 'Molds and jigs for volume', { k: 'work', s: 4, x: 4, d: ['testing'], opt: true, c: [500, 3000], b: [5000, 25000], p: [30000, 120000], h: [20, 80], o: ['soft tooling or 3D-printed molds', 'aluminium injection molds', 'steel multi-cavity molds'] }),
]);

const FOOTWEAR = parts([
  I('design', 'Design sketches and tech pack', 'Design', 'The shoe on paper, with every material named', { k: 'work', s: 2, x: 2, c: [0, 100], b: [500, 2000], p: [4000, 15000], h: [10, 60], o: ['your own sketches', 'a freelance footwear designer', 'a footwear design studio'] }),
  I('last', 'Last and patterns', 'Design', 'The foot shape the shoe is built around, and the cut panels', { k: 'work', s: 3, x: 4, d: ['design'], c: [100, 400], b: [500, 1500], p: [2000, 6000], h: [10, 40], o: ['a stock last', 'a modified last', 'a custom last and graded patterns'] }),
  I('upper', 'Upper panels', 'Upper', 'Covers the foot; most of the look', { s: 4, x: 3, d: ['last'], per: 'unit', c: [4, 10], b: [10, 25], p: [30, 90], o: ['synthetic leather or knit', 'quality suede, leather or engineered knit', 'full-grain Italian leather'] }),
  I('lining', 'Lining and padding', 'Upper', 'Comfort inside the shoe', { s: 3, x: 2, d: ['upper'], per: 'unit', c: [1, 3], b: [3, 8], p: [8, 20], o: ['polyester mesh', 'textile with memory foam', 'leather lining'] }),
  I('insole', 'Insole', 'Bottom', 'Cushion under the foot', { s: 3, x: 2, d: ['last'], per: 'unit', c: [1, 2], b: [2, 6], p: [6, 15], o: ['EVA foam', 'Ortholite-type foam', 'molded cork or leather'] }),
  I('midsole', 'Midsole', 'Bottom', 'Cushioning and support', { s: 4, x: 4, d: ['last'], per: 'unit', c: [2, 5], b: [5, 12], p: [12, 30], o: ['EVA', 'PU or blended foam', 'supercritical or PEBA foam'] }),
  I('outsole', 'Outsole', 'Bottom', 'Grip and wear', { s: 4, x: 3, d: ['midsole'], per: 'unit', c: [2, 5], b: [5, 10], p: [10, 25], o: ['standard rubber', 'abrasion-rated rubber', 'premium branded rubber'] }),
  I('laces', 'Laces, eyelets and closure', 'Upper', 'Holds the foot in', { s: 1, x: 1, d: ['upper'], per: 'unit', c: [0.3, 1], b: [1, 3], p: [3, 8], o: ['flat polyester laces', 'waxed laces and metal eyelets', 'custom aglets and hardware'] }),
  I('branding', 'Logos, labels and tags', 'Branding', 'The brand on the shoe', { s: 1, x: 2, d: ['upper'], per: 'unit', c: [0.3, 1], b: [1, 3], p: [3, 10], o: ['printed logo', 'embroidered or debossed logo', 'metal or molded branding'] }),
  I('samples', 'Sample rounds', 'Production', 'Physical samples until the fit and look are right', { k: 'work', s: 3, x: 3, d: ['upper', 'outsole', 'laces', 'insole', 'lining'], c: [300, 800], b: [1000, 3000], p: [4000, 12000], h: [10, 40], o: ['one round, one size', 'two or three rounds, a size run', 'many rounds with a top factory'] }),
  I('molds', 'Sole molds', 'Production', 'Tooling for a custom sole', { k: 'work', s: 4, x: 4, d: ['samples'], opt: true, c: [0, 0], b: [3000, 10000], p: [15000, 60000], h: [10, 40], o: ['use a factory stock sole', 'molds for a few sizes', 'a full size-run of custom molds'] }),
  I('production', 'Production run and fit testing', 'Production', 'Wear tests, then the first run', { k: 'work', s: 4, x: 3, d: ['samples'], c: [200, 600], b: [1000, 3000], p: [5000, 15000], h: [20, 80], o: ['wear tests with friends', 'structured wear testers and lab tests', 'lab abrasion, flex and slip tests'] }),
  I('packaging', 'Shoe box and packaging', 'Branding', 'Box, tissue and tags', { s: 3, x: 1, d: ['branding'], per: 'unit', c: [1, 2], b: [2, 5], p: [6, 20], o: ['stock kraft box', 'custom printed box', 'rigid box with dust bag'] }),
]);

const APPAREL = parts([
  I('design', 'Design and tech pack', 'Design', 'Sketches, measurements and materials', { k: 'work', s: 2, x: 2, c: [0, 100], b: [300, 1500], p: [3000, 10000], h: [8, 40], o: ['your own sketches', 'a freelance fashion designer', 'a design studio'] }),
  I('pattern', 'Pattern and size grading', 'Design', 'The cut pieces in every size', { k: 'work', s: 3, x: 4, d: ['design'], c: [100, 300], b: [400, 1200], p: [1500, 5000], h: [10, 40], o: ['a stock pattern adapted', 'a pattern maker, graded sizes', 'a custom block and full grading'] }),
  I('fabric', 'Main fabric', 'Materials', 'The garment body', { s: 4, x: 2, d: ['pattern'], per: 'unit', c: [3, 8], b: [8, 20], p: [25, 80], o: ['poly-cotton', 'organic cotton or technical fabric', 'premium wool, silk or Japanese denim'] }),
  I('lining', 'Lining and interfacing', 'Materials', 'Structure and comfort inside', { s: 3, x: 2, d: ['pattern'], per: 'unit', opt: true, c: [1, 3], b: [3, 8], p: [8, 25], o: ['polyester lining', 'cupro or cotton lining', 'silk lining'] }),
  I('trims', 'Trims (zips, buttons, drawcords)', 'Materials', 'Closures and details', { s: 1, x: 1, d: ['pattern'], per: 'unit', c: [0.5, 2], b: [2, 6], p: [6, 20], o: ['generic trims', 'YKK-class zips, branded buttons', 'custom metal hardware'] }),
  I('labels', 'Labels, care tags and branding', 'Branding', 'Brand, size and care information', { s: 1, x: 1, per: 'unit', c: [0.2, 0.6], b: [0.6, 2], p: [2, 6], o: ['printed labels', 'woven labels', 'custom woven and leather patches'] }),
  I('sample', 'Samples and fittings', 'Production', 'Make it, fit it, fix it', { k: 'work', s: 3, x: 3, d: ['fabric', 'trims'], c: [100, 400], b: [500, 2000], p: [3000, 10000], h: [8, 40], o: ['one sample', 'two rounds with a fit model', 'multiple rounds in every size'] }),
  I('cutsew', 'Cut and sew', 'Production', 'Factory labor per garment', { s: 3, x: 3, d: ['sample'], per: 'unit', c: [4, 10], b: [10, 25], p: [30, 90], o: ['overseas volume factory', 'smaller ethical or domestic factory', 'atelier or made-to-order'] }),
  I('packaging', 'Packaging', 'Branding', 'Bag, tissue and mailer', { s: 2, x: 1, d: ['labels'], per: 'unit', c: [0.3, 1], b: [1, 3], p: [3, 12], o: ['poly mailer', 'recycled mailer and tissue', 'branded box'] }),
]);

const VEHICLE = parts([
  I('concept', 'Concept and requirements', 'Design', 'Use, speed, range, seats, legal class', { k: 'work', s: 2, x: 2, c: [0, 0], b: [1000, 5000], p: [20000, 100000], h: [20, 100], o: ['your own spec', 'an engineering consultant', 'a design and engineering studio'] }),
  I('chassis', 'Chassis or hull', 'Structure', 'The load-bearing frame', { s: 5, x: 4, d: ['concept'], c: [500, 3000], b: [5000, 20000], p: [40000, 200000], h: [80, 400], o: ['donor chassis or kit', 'custom steel tube frame', 'carbon or aluminium monocoque'] }),
  I('body', 'Body panels', 'Body', 'Shape, weather protection, looks', { s: 5, x: 3, d: ['chassis'], c: [300, 2000], b: [3000, 15000], p: [30000, 150000], h: [60, 300], o: ['donor panels or fibreglass', 'custom fibreglass', 'carbon composite'] }),
  I('powertrain', 'Powertrain (motor or engine, drive)', 'Propulsion', 'Makes it move', { s: 4, x: 5, d: ['chassis'], c: [800, 4000], b: [6000, 25000], p: [40000, 200000], h: [40, 200], o: ['used donor powertrain', 'new crate motor or EV kit', 'performance EV drive units'] }),
  I('energy', 'Energy storage (battery or fuel system)', 'Propulsion', 'Range', { s: 4, x: 4, d: ['powertrain'], c: [500, 3000], b: [4000, 15000], p: [20000, 80000], h: [20, 100], o: ['used modules or stock tank', 'new battery modules with BMS', 'custom high-density pack'] }),
  I('suspension', 'Suspension and steering', 'Chassis systems', 'Control and comfort', { s: 4, x: 4, d: ['chassis'], c: [300, 1500], b: [2000, 8000], p: [10000, 40000], h: [20, 100], o: ['donor parts', 'adjustable coilovers and new steering', 'motorsport-grade'] }),
  I('brakes', 'Brakes', 'Safety', 'Stops it', { s: 3, x: 3, d: ['suspension'], c: [200, 800], b: [1000, 4000], p: [6000, 20000], h: [10, 40], o: ['donor brakes, rebuilt', 'new disc brakes all round', 'carbon-ceramic or performance kits'] }),
  I('electrical', 'Electrical, lighting and controls', 'Electrical', 'Lights, dashboard, switches', { s: 3, x: 4, d: ['energy'], c: [200, 1000], b: [1500, 6000], p: [10000, 40000], h: [30, 150], o: ['donor harness', 'new harness and digital dash', 'custom electronics and displays'] }),
  I('safety', 'Safety systems (belts, crash structure, protection)', 'Safety', 'Protects people', { s: 3, x: 4, d: ['chassis'], c: [200, 1000], b: [1000, 5000], p: [10000, 50000], h: [20, 80], o: ['belts and roll hoop', 'harnesses, cage and fire suppression', 'engineered crash structures'] }),
  I('homologation', 'Testing, inspection and registration', 'Compliance', 'Makes it legal to use', { k: 'work', s: 3, x: 4, d: ['brakes', 'electrical', 'safety', 'body'], c: [200, 1000], b: [2000, 10000], p: [20000, 200000], h: [20, 120], o: ['track or off-road use only', 'state inspection and registration', 'full certification'] }),
]);

const AEROSPACE = parts([
  I('mission', 'Mission and requirements', 'Design', 'What it must do, and the rules that apply', { k: 'work', s: 2, x: 3, c: [0, 0], b: [2000, 10000], p: [50000, 500000], h: [20, 200], o: ['a model-scale goal', 'a university or research-scale spec', 'a commercial program spec'] }),
  I('simulation', 'Design and simulation', 'Design', 'Aerodynamics, structures and trajectory in software', { k: 'work', s: 3, x: 4, d: ['mission'], c: [0, 200], b: [2000, 15000], p: [100000, 1000000], h: [40, 400], o: ['free simulators (OpenRocket, XFLR5)', 'paid CFD and FEA tools', 'an engineering team'] }),
  I('airframe', 'Airframe or structure', 'Structure', 'Carries every load', { s: 5, x: 4, d: ['simulation'], c: [50, 500], b: [3000, 30000], p: [500000, 10000000], h: [40, 400], o: ['model-scale kit or composite tubes', 'research-grade composite structure', 'flight-certified structure'] }),
  I('propulsion', 'Propulsion (category only)', 'Propulsion', 'Thrust: motors, propellers or certified motors', { s: 4, x: 5, d: ['airframe'], c: [50, 500], b: [2000, 30000], p: [1000000, 50000000], h: [20, 400], o: ['electric motors or certified hobby motors', 'certified high-power motors or electric propulsion', 'a licensed propulsion supplier'] }),
  I('power', 'Electrical power', 'Power', 'Batteries or generators for the systems', { s: 3, x: 3, d: ['airframe'], c: [30, 200], b: [500, 5000], p: [50000, 2000000], h: [10, 100], o: ['hobby LiPo packs', 'certified packs with BMS', 'flight-qualified power systems'] }),
  I('avionics', 'Avionics and flight control', 'Control', 'Guidance, navigation and control', { s: 2, x: 5, d: ['power', 'sensors'], c: [50, 300], b: [1000, 10000], p: [200000, 5000000], h: [40, 400], o: ['open-source flight controller (ArduPilot, PX4)', 'research flight computer', 'certified avionics'] }),
  I('sensors', 'Sensors and navigation', 'Sensing', 'Position, attitude, health', { s: 1, x: 4, c: [30, 200], b: [500, 5000], p: [50000, 1000000], h: [10, 100], o: ['hobby GPS and IMU', 'tactical-grade IMU and GNSS', 'flight-grade navigation'] }),
  I('comms', 'Communications and telemetry', 'Communications', 'Data link to the ground', { s: 2, x: 4, d: ['avionics'], c: [30, 200], b: [500, 5000], p: [50000, 2000000], h: [10, 100], o: ['hobby telemetry radio', 'licensed long-range link', 'flight-certified communications'] }),
  I('thermal', 'Thermal management', 'Thermal', 'Keeps parts in their temperature range', { s: 2, x: 4, d: ['airframe'], opt: true, c: [0, 50], b: [300, 3000], p: [50000, 1000000], h: [5, 80], o: ['passive venting', 'insulation and heat sinks', 'active thermal control'] }),
  I('recovery', 'Recovery or landing system', 'Safety', 'Brings it down safely', { s: 3, x: 4, d: ['avionics'], c: [30, 200], b: [500, 5000], p: [100000, 5000000], h: [10, 100], o: ['parachute', 'dual-deploy recovery or landing gear', 'certified recovery or landing systems'] }),
  I('testing', 'Ground tests, flight tests and licensing', 'Compliance', 'Proves it, legally', { k: 'work', s: 4, x: 5, d: ['recovery', 'comms', 'propulsion'], c: [50, 500], b: [3000, 30000], p: [1000000, 20000000], h: [20, 400], o: ['club launches or registered drone flights', 'university test campaigns with waivers', 'FAA certification or launch licensing'] }),
]);

const BUILDING = parts([
  I('design', 'Design, drawings and permits', 'Planning', 'Plans the authorities approve', { k: 'work', s: 3, x: 3, c: [500, 3000], b: [5000, 20000], p: [30000, 150000], h: [20, 120], o: ['stock plans, owner-filed permits', 'a drafter and engineer', 'an architect'] }),
  I('site', 'Site preparation', 'Site', 'Clearing, grading, utilities to the site', { s: 5, x: 3, d: ['design'], c: [1000, 5000], b: [5000, 20000], p: [20000, 80000], h: [20, 80], o: ['minimal grading', 'full site work', 'complex site and landscaping'] }),
  I('foundation', 'Foundation', 'Structure', 'Holds the building up', { s: 5, x: 4, d: ['site'], c: [2000, 8000], b: [10000, 40000], p: [40000, 150000], h: [20, 120], o: ['piers or skids', 'slab on grade', 'full basement'] }),
  I('framing', 'Framing and structure', 'Structure', 'Walls, floors and roof structure', { s: 5, x: 4, d: ['foundation'], c: [3000, 15000], b: [20000, 80000], p: [80000, 300000], h: [80, 400], o: ['owner-built wood frame', 'contractor wood frame', 'steel, timber frame or SIPs'] }),
  I('roof', 'Roof', 'Envelope', 'Keeps the weather out', { s: 5, x: 3, d: ['framing'], c: [1000, 5000], b: [8000, 25000], p: [25000, 80000], h: [20, 100], o: ['metal or asphalt, owner-installed', 'architectural shingles or standing seam', 'slate, tile or green roof'] }),
  I('envelope', 'Walls, windows and doors', 'Envelope', 'Insulation, openings, cladding', { s: 4, x: 3, d: ['framing'], c: [2000, 8000], b: [10000, 40000], p: [40000, 150000], h: [40, 200], o: ['basic insulation and vinyl windows', 'good insulation and quality windows', 'high-performance envelope'] }),
  I('mep', 'Electrical, plumbing and HVAC', 'Systems', 'Power, water, heating and cooling', { s: 4, x: 5, d: ['framing'], c: [3000, 10000], b: [15000, 50000], p: [50000, 200000], h: [40, 200], o: ['minimal circuits and a mini-split', 'full licensed systems', 'smart home, geothermal or solar'] }),
  I('interior', 'Interior finishes', 'Interior', 'Floors, walls, kitchen, bath', { s: 4, x: 3, d: ['mep', 'envelope'], c: [2000, 10000], b: [15000, 60000], p: [60000, 300000], h: [60, 300], o: ['basic finishes, owner-installed', 'mid-grade finishes, contractor', 'custom high-end finishes'] }),
  I('inspection', 'Inspections and occupancy', 'Planning', 'Legal sign-off', { k: 'work', s: 2, x: 2, d: ['interior', 'roof'], c: [200, 1000], b: [1000, 3000], p: [3000, 10000], h: [5, 20], o: ['required inspections', 'inspections plus energy rating', 'third-party certification'] }),
]);

const SOFTWARE = parts([
  I('requirements', 'Requirements and user stories', 'Product', 'Who uses it and what they must be able to do', { k: 'feature', s: 2, x: 2, c: [0, 0], b: [500, 2000], p: [4000, 15000], h: [8, 40], o: ['your own list', 'a product consultant', 'a product team discovery phase'] }),
  I('ux', 'User flows and wireframes', 'Product', 'Every screen and how people move between them', { k: 'feature', s: 3, x: 3, d: ['requirements'], c: [0, 0], b: [1000, 4000], p: [8000, 30000], h: [16, 80], o: ['sketches or Figma templates', 'a freelance UX designer', 'a design agency'] }),
  I('frontend', 'Screens and interface', 'Frontend', 'What users see and touch', { k: 'feature', s: 4, x: 3, d: ['ux'], c: [0, 300], b: [4000, 15000], p: [30000, 120000], h: [60, 400], o: ['no-code builder (Bubble, FlutterFlow, Webflow)', 'a freelance developer', 'an agency or in-house team'] }),
  I('auth', 'Sign-in and permissions', 'Backend', 'Accounts, roles, who can see what', { k: 'feature', s: 2, x: 3, d: ['backend'], c: [0, 50], b: [1000, 4000], p: [8000, 25000], h: [10, 60], o: ['built-in auth (Firebase, Supabase)', 'custom roles on a managed service', 'enterprise SSO and audit'] }),
  I('data', 'Data model and database', 'Backend', 'What is stored and how it relates', { k: 'feature', s: 3, x: 3, d: ['requirements'], c: [0, 0], b: [800, 3000], p: [6000, 20000], h: [10, 60], o: ['a no-code database', 'Postgres via Supabase or Firebase', 'designed schema with migrations and backups'] }),
  I('backend', 'Backend and API', 'Backend', 'The logic behind the screens', { k: 'feature', s: 4, x: 4, d: ['data'], c: [0, 300], b: [4000, 15000], p: [30000, 150000], h: [40, 400], o: ['no-code workflows', 'serverless functions', 'a custom service with full test coverage'] }),
  I('integrations', 'Integrations (payments, email, maps)', 'Backend', 'Outside services it talks to', { k: 'feature', s: 3, x: 4, d: ['backend'], opt: true, c: [0, 100], b: [1500, 6000], p: [10000, 40000], h: [10, 120], o: ['plugins and Zapier', 'Stripe and email APIs', 'custom integrations with monitoring'] }),
  I('admin', 'Admin dashboard', 'Frontend', 'How you run it day to day', { k: 'feature', s: 3, x: 3, d: ['backend', 'auth'], opt: true, c: [0, 0], b: [1500, 5000], p: [10000, 40000], h: [16, 120], o: ['the database console', 'a simple admin panel', 'a full back-office'] }),
  I('hosting', 'Hosting and infrastructure', 'Infrastructure', 'Where it runs', { k: 'feature', s: 2, x: 3, d: ['backend'], per: 'month', c: [0, 25], b: [25, 150], p: [300, 2000], h: [4, 40], o: ['free tiers', 'managed cloud plans', 'scaled cloud with redundancy'] }),
  I('testing', 'Testing and quality', 'Delivery', 'Proves it works before users do', { k: 'feature', s: 3, x: 3, d: ['frontend', 'backend'], c: [0, 0], b: [1000, 4000], p: [8000, 30000], h: [16, 120], o: ['manual testing', 'automated tests and a beta group', 'QA team and test automation'] }),
  I('launch', 'Deployment and store release', 'Delivery', 'Live on the web or in the app stores', { k: 'feature', s: 2, x: 2, d: ['testing', 'hosting'], c: [0, 125], b: [125, 500], p: [1000, 5000], h: [4, 30], o: ['web only, or developer accounts ($99 Apple, $25 Google)', 'store listings and review help', 'release management and ASO'] }),
  I('maintenance', 'Analytics, support and maintenance', 'Delivery', 'Keeps it running and improving', { k: 'feature', s: 2, x: 2, d: ['launch'], per: 'month', c: [0, 50], b: [200, 1000], p: [3000, 15000], h: [4, 40], o: ['you fix issues', 'a retainer developer', 'a support and maintenance team'] }),
]);

const GAME = parts([
  I('concept', 'Concept, pillars and core loop', 'Design', 'What the player does over and over, and why it is fun', { k: 'asset', s: 2, x: 3, c: [0, 0], b: [500, 2000], p: [5000, 20000], h: [10, 60], o: ['your own design doc', 'a freelance game designer', 'a design team'] }),
  I('engine', 'Engine and technical setup', 'Technology', 'Unity, Unreal, Godot; build pipeline', { k: 'asset', s: 2, x: 3, d: ['concept'], c: [0, 0], b: [0, 2000], p: [5000, 30000], h: [8, 60], o: ['Godot or free tiers', 'Unity or Unreal with paid tools', 'custom tooling and pipelines'] }),
  I('prototype', 'Greybox prototype', 'Production', 'The core loop playable with placeholder art', { k: 'asset', s: 3, x: 3, d: ['engine'], c: [0, 0], b: [2000, 8000], p: [15000, 60000], h: [40, 200], o: ['you build it', 'a freelance programmer', 'a small team'] }),
  I('mechanics', 'Mechanics and systems', 'Systems', 'Controls, combat or puzzles, AI, economy', { k: 'asset', s: 4, x: 5, d: ['prototype'], c: [0, 0], b: [5000, 25000], p: [60000, 400000], h: [100, 1000], o: ['you code it', 'a contract programmer', 'a programming team'] }),
  I('progression', 'Player progression', 'Systems', 'Levels, unlocks, rewards', { k: 'asset', s: 3, x: 3, d: ['mechanics'], c: [0, 0], b: [1000, 5000], p: [15000, 60000], h: [20, 160], o: ['simple level-ups', 'designed progression curves', 'live-ops economy'] }),
  I('world', 'Levels and world', 'Content', 'Where the game happens', { k: 'asset', s: 5, x: 4, d: ['mechanics'], c: [0, 200], b: [5000, 30000], p: [80000, 500000], h: [80, 1200], o: ['asset-store kits', 'a freelance level designer', 'a level design team'] }),
  I('characters', 'Characters and art assets', 'Art', 'Characters, props, animation', { k: 'asset', s: 4, x: 4, d: ['concept'], c: [0, 300], b: [5000, 30000], p: [100000, 800000], h: [80, 1500], o: ['asset store or AI-assisted concepts', 'freelance artists and animators', 'an art team'] }),
  I('ui', 'UI and menus', 'Art', 'HUD, menus, settings, accessibility', { k: 'asset', s: 2, x: 3, d: ['mechanics'], c: [0, 50], b: [1000, 5000], p: [15000, 60000], h: [20, 160], o: ['template UI kits', 'a freelance UI artist', 'a UI/UX team'] }),
  I('audio', 'Audio and music', 'Audio', 'Effects, music and voice', { k: 'asset', s: 3, x: 2, d: ['concept'], c: [0, 100], b: [1500, 8000], p: [20000, 150000], h: [10, 200], o: ['royalty-free libraries', 'a freelance composer and sound designer', 'an original score and voice cast'] }),
  I('playtest', 'Playtesting and QA', 'Production', 'Finds what is broken or boring', { k: 'asset', s: 3, x: 3, d: ['world', 'ui', 'progression'], c: [0, 0], b: [1000, 5000], p: [20000, 100000], h: [20, 300], o: ['friends and Discord', 'paid playtests', 'a QA team'] }),
  I('launch', 'Store release and marketing', 'Launch', 'Steam, consoles or mobile stores, trailer', { k: 'asset', s: 3, x: 2, d: ['playtest', 'audio', 'characters'], c: [100, 300], b: [2000, 10000], p: [50000, 500000], h: [20, 200], o: ['Steam page ($100 fee) and social posts', 'trailer, press kit and ads', 'a publisher or agency campaign'] }),
]);

const BUSINESS = parts([
  I('research', 'Market and offer research', 'Strategy', 'Who buys, what they pay, who else sells it', { k: 'resource', s: 2, x: 2, c: [0, 0], b: [200, 1000], p: [3000, 15000], h: [10, 40], o: ['your own research', 'paid reports and interviews', 'a consulting study'] }),
  I('legal', 'Business setup, licenses and insurance', 'Legal', 'The entity and permission to operate', { k: 'resource', s: 2, x: 3, d: ['research'], c: [100, 500], b: [800, 3000], p: [5000, 15000], h: [5, 30], o: ['an LLC filed yourself', 'a lawyer-filed entity with insurance', 'full legal and compliance setup'] }),
  I('brand', 'Brand, logo and website', 'Brand', 'How customers find and trust it', { k: 'resource', s: 3, x: 2, d: ['research'], c: [0, 300], b: [1500, 6000], p: [15000, 60000], h: [10, 80], o: ['a template site and logo', 'a freelance designer and custom site', 'a branding agency'] }),
  I('equipment', 'Equipment and tools', 'Operations', 'What the work needs', { k: 'resource', s: 4, x: 2, d: ['legal'], c: [500, 5000], b: [5000, 30000], p: [30000, 200000], h: [5, 40], o: ['used equipment', 'new mid-range equipment', 'premium fit-out'] }),
  I('location', 'Location or workspace', 'Operations', 'Where it runs (online, home or a lease)', { k: 'resource', s: 5, x: 3, d: ['legal'], per: 'month', opt: true, c: [0, 300], b: [1000, 5000], p: [5000, 25000], h: [10, 60], o: ['online or home-based', 'a shared or small lease', 'a prime location'] }),
  I('people', 'People and roles', 'Team', 'Who does the work', { k: 'resource', s: 4, x: 3, d: ['legal'], per: 'month', c: [0, 0], b: [3000, 10000], p: [15000, 60000], h: [10, 60], o: ['just you', 'part-time help or contractors', 'a hired team'] }),
  I('operations', 'Workflows and software', 'Operations', 'Booking, payments, accounting, inventory', { k: 'resource', s: 2, x: 2, d: ['legal'], per: 'month', c: [0, 50], b: [100, 400], p: [500, 3000], h: [5, 40], o: ['free tools', 'paid business software', 'integrated systems'] }),
  I('marketing', 'Marketing and launch', 'Brand', 'The first customers', { k: 'resource', s: 3, x: 2, d: ['brand'], c: [0, 500], b: [2000, 10000], p: [20000, 100000], h: [20, 120], o: ['social posts and word of mouth', 'paid ads and local promotion', 'an agency launch campaign'] }),
  I('capital', 'Working capital reserve', 'Finance', 'Runway until revenue covers costs', { k: 'resource', s: 4, x: 2, d: ['research'], c: [1000, 5000], b: [10000, 40000], p: [50000, 250000], o: ['one to two months of costs', 'three to six months of costs', 'six to twelve months of costs'] }),
]);

const PROJECT = parts([
  I('goal', 'Goal, scope and success measures', 'Planning', 'What done looks like', { k: 'task', s: 1, x: 2, c: [0, 0], b: [0, 500], p: [2000, 10000], h: [2, 16], o: ['your own one-page brief', 'a planning session with an expert', 'a professional project manager'] }),
  I('research', 'Research and references', 'Planning', 'What exists, what works, what it costs', { k: 'task', s: 2, x: 2, d: ['goal'], c: [0, 0], b: [100, 1000], p: [3000, 15000], h: [8, 60], o: ['free sources', 'paid sources and interviews', 'commissioned research'] }),
  I('resources', 'Tools, materials and software', 'Resources', 'What the work needs', { k: 'task', s: 3, x: 2, d: ['goal'], c: [0, 300], b: [500, 3000], p: [5000, 30000], h: [4, 30], o: ['free and borrowed tools', 'good tools and software', 'professional equipment'] }),
  I('people', 'People and roles', 'Resources', 'Who does what', { k: 'task', s: 3, x: 3, d: ['goal'], c: [0, 0], b: [1000, 6000], p: [10000, 60000], h: [4, 40], o: ['you and volunteers', 'freelancers', 'a hired team'] }),
  I('production', 'Production work', 'Production', 'Making the thing itself', { k: 'task', s: 5, x: 3, d: ['research', 'resources', 'people'], c: [0, 500], b: [2000, 15000], p: [20000, 150000], h: [40, 400], o: ['you make it', 'with paid help', 'a professional production'] }),
  I('review', 'Review and testing', 'Production', 'Checks quality before release', { k: 'task', s: 2, x: 2, d: ['production'], c: [0, 0], b: [200, 1500], p: [3000, 15000], h: [4, 40], o: ['self review', 'outside reviewers', 'professional QA or editors'] }),
  I('launch', 'Launch and delivery', 'Launch', 'Gets it to its audience', { k: 'task', s: 3, x: 2, d: ['review'], c: [0, 200], b: [500, 5000], p: [10000, 80000], h: [8, 80], o: ['free channels', 'paid promotion', 'a full campaign'] }),
  I('reserve', 'Budget reserve', 'Finance', 'For what goes wrong', { k: 'task', s: 2, x: 1, d: ['goal'], c: [0, 100], b: [500, 3000], p: [5000, 30000], o: ['10% of the budget', '15% of the budget', '20% of the budget'] }),
]);

// ── Project types ───────────────────────────────────────────────────────────────────────────────
// Order matters: the first type whose words match wins, so specific kinds come before general ones.
const STRUCTURES = Object.freeze({
  bill_of_materials: 'bill of materials',
  feature_list: 'feature and requirements list',
  asset_list: 'asset list',
  resource_plan: 'resource plan',
  work_breakdown: 'work breakdown',
});

const TYPES = [
  { id: 'aerospace', label: 'aerospace project', structure: 'bill_of_materials', items: AEROSPACE, words: /\b(?:rockets?|spacecraft|spaceships?|space\s?ships?|satellites?|cubesats?|aircraft|airplanes?|aeroplanes?|planes?|jets?|helicopters?|e?vtols?|gliders?|space\s?station|lunar|mars\s+(?:rover|lander|base))\b/i, highLevel: true, source: 'Aerospace_engineering',
    feasibility: 'Planned at model, research and simulation scale. Full-scale flight vehicles cost millions, take years and need government licensing.',
    regulated: ['Aviation and launch rules apply (in the US, the FAA: Part 101 for model rockets, Part 107 for drones, licensing for launches and certified aircraft).'],
    speculative: [['Faster-than-light travel, warp drives and reactionless drives', 'fiction: no known physics allows them'], ['Single-stage-to-orbit from a backyard', 'not feasible: orbit needs a large, multi-stage vehicle and a licensed launch']] },
  { id: 'wearable_robotics', label: 'wearable robotics project', structure: 'bill_of_materials', items: WEARABLE, words: /\b(?:exo-?skeletons?|exo-?suits?|iron\s?-?man|power(?:ed)?\s+armou?r|mech\s+suit|robotic\s+suit|robot\s+suit|wearable\s+robot(?:ic|ics)?|robotic\s+armou?r)\b/i, source: 'Powered_exoskeleton',
    feasibility: 'A walking, assist-only prototype is feasible for a skilled maker or small team. Strength amplification is research-grade; flight and weapons are not part of any version.',
    regulated: ['A powered suit worn by a person is safety-critical: build with emergency stops and joint limits, test unpowered first, and never test alone.', 'Medical or rehabilitation exoskeletons are FDA-regulated devices.'],
    speculative: [['Flight like Iron Man', 'fiction today: real jet suits use kerosene turbines, run minutes, and need training and permits'], ['Arc-reactor power', 'fiction: no compact reactor exists; real suits run on batteries for minutes to a few hours'], ['Bullet-proof full-body armor with full mobility', 'not possible at wearable weight with today\'s materials']] },
  { id: 'footwear', label: 'footwear product', structure: 'bill_of_materials', items: FOOTWEAR, words: /\b(?:sneakers?|shoes?|boots?|sandals?|footwear|trainers?|cleats?|slides)\b/i, source: 'Sneakers',
    feasibility: 'Feasible: footwear factories take small first orders (often 300 to 1,000 pairs per style), and samples come first.',
    regulated: ['Country-of-origin and material labeling apply; children\'s shoes also need CPSIA testing in the US.'],
    speculative: [] },
  { id: 'apparel', label: 'clothing product', structure: 'bill_of_materials', items: APPAREL, words: /\b(?:clothing|clothes|apparel|garments?|jackets?|hoodies?|t-?shirts?|shirts?|dress(?:es)?|pants|jeans|trousers|streetwear|coats?|sweaters?|leggings|swimwear|fashion\s+(?:line|brand|collection))\b/i, source: 'Clothing_industry',
    feasibility: 'Feasible: small-batch factories and print-on-demand exist for first runs.',
    regulated: ['Fibre-content, care and origin labels are required (FTC textile rules in the US); children\'s clothing needs CPSIA testing.'],
    speculative: [] },
  { id: 'vehicle', label: 'vehicle project', structure: 'bill_of_materials', items: VEHICLE, words: /\b(?:cars?|trucks?|motorcycles?|motorbikes?|e-?bikes?|bicycles?|bikes?|scooters?|boats?|yachts?|go-?karts?|karts?|vehicles?|vans?|campers?|rvs?|buggy|atvs?)\b/i, highLevel: true, source: 'Car',
    feasibility: 'A one-off build or conversion is feasible for a skilled builder; selling vehicles means crash testing and certification.',
    regulated: ['Road vehicles must meet safety standards and pass inspection to register (FMVSS/DOT in the US); boats follow Coast Guard rules.'],
    speculative: [['Flying cars for everyday use', 'prototypes exist but are not certified for ordinary road and air use'], ['Fully self-driving everywhere', 'not available to buy today']] },
  { id: 'game', label: 'game', structure: 'asset_list', items: GAME, words: /\b(?:video\s?games?|games?(?!\s+plan)|rpg|platformer|roguelike|mmo|metroidvania|unity\s+game|unreal\s+game)\b/i, source: 'Video_game_development', fictionOk: true,
    feasibility: 'A small game is feasible solo; scope is the usual risk, so prototype the core loop first.',
    regulated: ['Store age ratings (ESRB/PEGI or the store\'s questionnaire) and privacy rules for player data apply.'],
    speculative: [] },
  { id: 'software', label: 'software product', structure: 'feature_list', items: SOFTWARE, words: /\b(?:apps?|application|web\s?apps?|websites?|web\s?sites?|site|saas|platform|software|api|dashboard|chat\s?bot|browser\s+extension|plugin|portal|marketplace)\b/i, source: 'Software_development_process',
    feasibility: 'Feasible: a working first version can be built with no-code tools or one developer; complexity grows with integrations and scale.',
    regulated: ['Personal data brings privacy law (GDPR, CCPA); payments bring PCI rules through the payment provider; app stores review every release.'],
    speculative: [] },
  { id: 'building', label: 'building project', structure: 'bill_of_materials', items: BUILDING, words: /\b(?:house|cabin|tiny\s+home|building|shed|garage|barn|adu|extension\s+to\s+my\s+house|studio\s+building|warehouse)\b/i, source: 'Construction',
    feasibility: 'Feasible with permits; costs depend heavily on location, size and who builds it.',
    regulated: ['Building permits, codes and inspections apply; electrical and plumbing usually need licensed trades.'],
    speculative: [] },
  { id: 'electronics', label: 'electronics or robotics product', structure: 'bill_of_materials', items: ELECTRONICS, words: /\b(?:robots?|robotics|drones?|gadgets?|devices?|sensors?|smart\s+\w+|iot|electronics?|circuits?|wearables?|headsets?|speakers?|controllers?|3d\s+printer)\b/i, source: 'Robotics',
    feasibility: 'A working prototype is feasible with hobby parts; selling it adds certification and production engineering.',
    regulated: ['Electronics sold in the US need FCC compliance (CE in Europe); lithium batteries have shipping rules (UN 38.3); drones over 250 g need FAA registration.'],
    speculative: [] },
  { id: 'physical_product', label: 'physical product', structure: 'bill_of_materials', items: PRODUCT, words: /\b(?:products?|furniture|chairs?|tables?|desks?|tools?|appliances?|toys?|lamps?|bottles?|prototypes?|inventions?|gear|bags?|backpacks?|kitchen\s+\w+|cups?|mugs?|shelves|beds?)\b/i, source: 'New_product_development',
    feasibility: 'Feasible: prototypes come first; production adds tooling and minimum order quantities.',
    regulated: ['Products for children need CPSIA testing; anything plugged into mains power needs UL/CE certification; food-contact items need food-safe materials.'],
    speculative: [] },
  { id: 'business', label: 'business or service', structure: 'resource_plan', items: BUSINESS, words: /\b(?:business(?:es)?|brands?|company|startup|services?|shop|store|agency|restaurant|barbershop|salon|cafe|café|bakery|gym|clinic|franchise|subscription|consultancy)\b/i, source: 'Business_plan',
    feasibility: 'Feasible: the main risks are demand and cash flow, so validate demand before large spending.',
    regulated: ['Business registration, local licenses, sales tax and insurance apply; some trades need professional licenses.'],
    speculative: [] },
];
const PROJECT_TYPE = { id: 'project', label: 'project', structure: 'work_breakdown', items: PROJECT, words: null, source: 'Project_planning',
  feasibility: 'Feasibility depends on scope; the plan starts with the goal and the smallest version that proves it.', regulated: [], speculative: [] };

export const PROJECT_TYPES = Object.freeze([...TYPES, PROJECT_TYPE].map((t) => Object.freeze({ id: t.id, label: t.label, structure: t.structure })));

/** The project type for a request: the first type whose words match, else the general project. */
export function classifyProject(text) {
  const t = String(text || '');
  for (const type of TYPES) {
    const m = type.words.exec(t);
    if (m) return { type, matched: m[0] };
  }
  return { type: PROJECT_TYPE, matched: '' };
}

// ── Safety layer ────────────────────────────────────────────────────────────────────────────────
const WEAPON = /\b(?:guns?|firearms?|rifles?|pistols?|shotguns?|ammo|ammunition|bullets?|explosives?|bombs?|grenades?|warheads?|missiles?|landmines?|flamethrowers?|silencers?|suppressors?|weapon(?:s|i[sz]ed)?|armed|repulsors?\s+(?:weapons?|blasts?|that\s+(?:shoot|fire))|lasers?\s+(?:weapons?|guns?)|tasers?|stun\s+guns?)\b/i;
const HARM = /\b(?:bio-?weapons?|chemical\s+weapons?|nerve\s+agents?|poisons?|toxins?\s+(?:to|that)|malware|ransomware|keyloggers?|spyware|botnets?|untraceable|ghost\s+guns?|stalk(?:ing|erware)?|hack\s+into)\b/i;
const PROPELLANT = /\b(?:propellant|rocket\s+fuel|oxidi[sz]er|solid\s+fuel|thermite|black\s+powder)\b/i;
const FICTION = /\b(?:story|stories|novel|film|movie|screenplay|script|comic|book|series|animation|cartoon|tabletop|board\s+game|cosplay\s+prop|costume)\b/i;
const MEDICAL = /\b(?:medical|prosthe(?:tic|sis)|implants?|surgical|insulin|pacemakers?|rehab(?:ilitation)?|diagnos\w+)\b/i;

/**
 * What CHE will and will not plan. `refuse`: nothing is planned (weapons, harm). `redirect`: the
 * project is planned with the harmful part left out. `high_level`: regulated or dangerous systems,
 * planned as categories, simulation and testing only. `ok` otherwise.
 */
export function safetyCheck(text, type) {
  const t = String(text || '');
  const notes = [];
  const excluded = [];
  if (HARM.test(t) || (type.id === 'software' && /\b(?:hack|exploit|phish)\w*/i.test(t))) {
    return { level: 'refuse', notes: ['CHE does not plan tools for harming people, breaking into systems or evading the law.'], excluded: [], alternatives: ['a security-testing plan for systems you own', 'a privacy or safety product that protects people instead'] };
  }
  const weapon = WEAPON.exec(t);
  // A game, or a story, film or comic, may have weapons as fiction; nothing real is designed.
  const fiction = type.fictionOk || (type.id === 'project' && FICTION.test(t));
  if (weapon) {
    if (!fiction && ['project', 'aerospace', 'electronics', 'vehicle', 'physical_product'].includes(type.id)) {
      return { level: 'refuse', notes: [`CHE does not design weapons, weapon parts or armed vehicles (the request mentions "${weapon[0]}").`], excluded: [], alternatives: ['the same project without any weapon', 'a simulation or game version, where weapons are fictional', 'a safety or protective product'] };
    }
    if (!fiction) {
      excluded.push('Weapons and anything that shoots, fires or explodes are left out of every version.');
    } else {
      notes.push('Weapons here are fictional game or story content only; nothing real is designed.');
    }
  }
  if (PROPELLANT.test(t) || type.id === 'aerospace') excluded.push('No propellant or energetic-material formulas and no engine build instructions; propulsion is planned as certified, bought-in categories.');
  const medical = MEDICAL.test(t);
  if (medical) notes.push('Medical devices are FDA-regulated (or the local equivalent); this is a concept and research plan, not a clinical design.');
  const level = type.highLevel || medical ? 'high_level' : (excluded.length ? 'redirect' : 'ok');
  if (type.highLevel) notes.push('High-level engineering plan: systems, categories, simulation and testing, not build instructions for flight or road use.');
  return { level, notes: [...notes, ...type.regulated], excluded, alternatives: [] };
}

// ── Requests ────────────────────────────────────────────────────────────────────────────────────
const WAKE = /^(?:(?:hey\s+)?(?:che|chay|chey|shay)[,:]?\s+)?(?:please\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|help\s+me\s+|i\s+want\s+you\s+to\s+|i\s+want\s+to\s+|let's\s+|lets\s+)*/i;
const VERB = /^(?:design|plan|break\s+down|turn|come\s+up\s+with|create|make|map\s+out|estimate|draft|give\s+me|show\s+me|price\s+out|cost\s+out|put\s+together|lay\s+out|work\s+out|sketch\s+out|develop)\b/i;
const ASK = /\b(?:prototype|break\s+(?:it\s+|this\s+|that\s+)?down|bill\s+of\s+materials|boms?\b|parts?\s+list|the\s+parts|components|cost\s+(?:estimate|breakdown)|estimated?\s+(?:the\s+)?(?:total\s+)?cost|how\s+much\s+(?:it|this)\s+(?:would|will)\s+cost|cheapest|most\s+expensive|from\s+concept\s+to\s+production|project\s+plan|visual\s+(?:project\s+)?plan|turn\s+(?:this|my|the|an?)\s+(?:idea|concept)|architecture\s+(?:for|of)|production\s+roadmap|game\s+(?:production\s+)?roadmap|launch\s+plan|dependenc\w+|major\s+systems|subsystems|render\s+the\s+(?:parts|pieces))\b/i;
const STRONG = /\b(?:prototype|break\s+(?:it\s+|this\s+|that\s+)?down|bill\s+of\s+materials|boms?\b|parts?\s+list|cost\s+breakdown|from\s+concept\s+to\s+production|project\s+plan|visual\s+(?:project\s+)?plan|turn\s+(?:this|my|the|an?)\s+(?:idea|concept)|architecture\s+(?:for|of)|production\s+roadmap|game\s+(?:production\s+)?roadmap|major\s+systems|subsystems|render\s+the\s+(?:parts|pieces)|work\s+breakdown)\b/i;
const NOT_PLAN = /\b(?:my\s+(?:day|week|month|morning|evening|weekend|schedule|calendar|trip|workout|meals?|diet)|meeting|this\s+screen|che'?s?\s+own|in\s+che\b|your\s+(?:code|app)|the\s+office\s+screen|pull\s+request|\bpr\s*#?\d|trade|trading|mnq|youtube\s+video|ai\s+(?:assistant|agent|receptionist|employee|worker)s?|prompts?|logo|funnels?|workflows?|automations?|routines?|checklists?|workout|lesson\s+plan|meal\s+plan)\b/i;

/** A planning request, or null. `idea` is the request without the wake words. */
export function projectPlanIntent(message) {
  const raw = String(message || '').trim();
  if (!raw || raw.length > 1500) return null;
  const body = raw.replace(WAKE, '').trim();
  if (!VERB.test(body) || NOT_PLAN.test(body)) return null;
  // "Design X" is a plan when X is a kind of project CHE can decompose. Planning verbs (design, plan,
  // break down, make…) take any cue; "show me" and "give me" take only a strong one, so "show me the
  // cheapest car insurance" stays a question. A general project needs a strong cue too.
  const known = classifyProject(body).type.id !== 'project';
  const strong = STRONG.test(body);
  if (/^design\b/i.test(body) && known) return { idea: body.replace(/[.?!]+$/, '') };
  if (!ASK.test(body)) return null;
  // A weapon or harm asked for with a planning cue always reaches the safety layer, which refuses it.
  if (WEAPON.test(body) || HARM.test(body)) return { idea: body.replace(/[.?!]+$/, '') };
  if (!strong && (!known || /^(?:give\s+me|show\s+me|estimate)\b/i.test(body))) return null;
  return { idea: body.replace(/[.?!]+$/, '') };
}

// "This idea", "it", "this concept": the subject was said in an earlier turn.
const REFERS_BACK = /\b(?:this|that|my|the)\s+(?:idea|concept|project|product)\b|\b(?:break\s+(?:it|this|that)\s+down|for\s+(?:it|this|that))\b/i;

/** The request text to plan from: the message, plus the last owner turn when the message points back at it. */
export function planSubject(idea, history = []) {
  const { type } = classifyProject(idea);
  if (type.id !== 'project' || !REFERS_BACK.test(idea)) return idea;
  const last = [...(Array.isArray(history) ? history : [])].reverse().find((h) => String(h?.role) === 'user' && String(h.content || h.text || '').trim());
  const before = String(last?.content || last?.text || '').trim();
  return before && classifyProject(before).type.id !== 'project' ? `${before}. ${idea}` : (before ? `${idea}. ${before}` : idea);
}

// Owner requirements: the "with …" or "that …" part of the request, split into phrases.
function requirementsOf(text) {
  const m = /\b(?:with|that\s+(?:has|have|can|includes?)|including|featuring)\s+(.+)$/i.exec(text);
  if (!m) return [];
  return m[1].split(/,|;|\band\b|\bplus\b/i).map((s) => s.replace(/\b(?:show me|render|estimate|categorize|sort|and)\b.*$/i, '').trim()).filter((s) => s.length > 2 && s.length < 80).slice(0, 8);
}

function titleOf(idea) {
  let t = idea.replace(VERB, '').replace(/^\s*(?:down\s+)?/i, '').replace(/\s*[.?!]+$/, '').trim();
  // "this car into its major systems" names the car; "this idea into a mobile app" names the app.
  const into = /^(?:this|that|my|the|an?)\s+(.+?)\s+into\s+(?:its|a|an|the)?\s*(.+)$/i.exec(t);
  if (into) t = /^(?:idea|concept|project|thing)$/i.test(into[1]) ? into[2] : into[1];
  t = t.replace(/^(?:a|an|the|me|my)\s+/i, '').split(/[.?!,;]|\s+(?:and\s+)?(?:show|render|estimate|categori[sz]e|sort|compare|give)\b/i)[0].trim();
  const words = t.split(/\s+/).slice(0, 12).join(' ');
  return words ? words[0].toUpperCase() + words.slice(1) : 'Project plan';
}

const an = (word) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);

// ── Estimates, ordering and the plan ────────────────────────────────────────────────────────────
const TIERS = ['cheapest', 'balanced', 'premium'];
const TIER_KEYS = { cheapest: 'c', balanced: 'b', premium: 'p' };
const SIZE_WORDS = { 1: 'tiny', 2: 'small', 3: 'medium', 4: 'large', 5: 'very large' };
const SCOPE_WORDS = { 1: 'small task', 2: 'small', 3: 'medium', 4: 'large', 5: 'very large' };
// Effort per week for each tier: DIY part-time, a small paid team, a full professional team.
const HOURS_PER_WEEK = { cheapest: 10, balanced: 40, premium: 120 };

const sum = (pairs) => pairs.reduce((acc, [lo, hi]) => [acc[0] + lo, acc[1] + hi], [0, 0]);
const round = (n) => (n >= 1000 ? Math.round(n / 50) * 50 : n >= 100 ? Math.round(n / 5) * 5 : Math.round(n * 100) / 100);

/** Dependency levels: stage 1 needs nothing, stage n needs only earlier stages. Cycles are broken by order. */
export function dependencyStages(items) {
  const ids = new Set(items.map((i) => i.id));
  const level = new Map();
  const visit = (item, seen = new Set()) => {
    if (level.has(item.id)) return level.get(item.id);
    if (seen.has(item.id)) return 1;
    seen.add(item.id);
    const deps = (item.needs || []).filter((d) => ids.has(d)).map((d) => visit(items.find((i) => i.id === d), seen));
    const n = deps.length ? Math.max(...deps) + 1 : 1;
    level.set(item.id, n);
    return n;
  };
  items.forEach((i) => visit(i));
  return level;
}

export const SORTS = Object.freeze({
  size: 'smallest to largest',
  complexity: 'simplest to most complex',
  cost: 'cheapest to most expensive',
  priority: 'highest to lowest priority',
  dependency: 'earliest to latest dependency',
  required: 'required before optional',
});

/** The items in one of SORTS' orders; `tier` picks the cost column. Stable. */
export function sortItems(items, by = 'dependency', tier = 'balanced') {
  const mid = (i) => { const r = i.cost?.[tier] || [0, 0]; return (r[0] + r[1]) / 2; };
  const key = {
    size: (i) => i.size,
    complexity: (i) => i.complexity,
    cost: mid,
    priority: (i) => -i.priority,
    dependency: (i) => i.stage,
    required: (i) => (i.required ? 0 : 1),
  }[by] || ((i) => i.stage);
  return items.map((item, index) => ({ item, index })).sort((a, b) => key(a.item) - key(b.item) || a.index - b.index).map((x) => x.item);
}

function tierTotals(items, tier) {
  const pick = (per) => sum(items.filter((i) => i.required && i.per === per).map((i) => i.cost[tier]));
  const hours = sum(items.filter((i) => i.required && i.effort_hours).map((i) => i.effort_hours));
  const weeks = [Math.max(1, Math.ceil(hours[0] / HOURS_PER_WEEK[tier])), Math.max(1, Math.ceil(hours[1] / HOURS_PER_WEEK[tier]))];
  return { one_time: pick('once').map(round), per_unit: pick('unit').map(round), monthly: pick('month').map(round), effort_hours: hours, weeks };
}

const money = ([lo, hi]) => {
  const f = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
  return lo === hi ? f(lo) : `${f(lo)} to ${f(hi)}`;
};

function costPhrase(totals) {
  const parts = [];
  if (totals.one_time[1] > 0) parts.push(money(totals.one_time));
  if (totals.per_unit[1] > 0) parts.push(`${money(totals.per_unit)} per unit`);
  if (totals.monthly[1] > 0) parts.push(`${money(totals.monthly)} a month`);
  return parts.join(' plus ') || '$0';
}

const STAGE_NAMES = {
  bill_of_materials: ['Design and core structure', 'Main systems', 'Integration', 'Finishing and testing', 'Production and release'],
  feature_list: ['Discovery', 'Design and data', 'Build', 'Integrate and test', 'Launch and run'],
  asset_list: ['Concept', 'Prototype', 'Production', 'Polish and test', 'Launch'],
  resource_plan: ['Validate', 'Set up', 'Build out', 'Launch', 'Run'],
  work_breakdown: ['Define', 'Prepare', 'Produce', 'Review', 'Deliver'],
};

/**
 * Builds the plan for a request. `sources` are public pages actually read (see researchSource).
 * The result is plain data: the phone draws it, CHE speaks it, the Brain stores it.
 */
export function buildPlan(request, { id, now = new Date().toISOString(), sources = [] } = {}) {
  const text = String(request || '').trim().replace(WAKE, '').trim();
  const { type, matched } = classifyProject(text);
  const safety = safetyCheck(text, type);
  const planId = id || `plan-${Date.now().toString(36)}`;
  const base = {
    id: planId, version: PLAN_VERSION, request: text, title: titleOf(text), created_at: now,
    type: type.id, type_label: type.label, matched,
    structure: type.structure, structure_label: STRUCTURES[type.structure],
    safety,
  };
  if (safety.level === 'refuse') {
    return { ...base, refused: true, items: [], systems: [], stages: [], tiers: {}, sources: [], spoken: `I won't plan that, sir. ${safety.notes.join(' ')} I can plan ${safety.alternatives.join(', or ')}.` };
  }

  const asked = requirementsOf(text);
  const words = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const items = type.items.map((t) => {
    const nameWords = new Set(words(`${t.name} ${t.id}`));
    const askedFor = asked.some((r) => words(r).some((w) => nameWords.has(w) || nameWords.has(w.replace(/s$/, ''))));
    const required = !t.opt || askedFor;
    return {
      id: t.id, name: t.name, kind: t.k, system: t.system, purpose: t.purpose,
      required, asked: askedFor, quantity: 1, per: t.per || 'once',
      size: t.s, size_label: (t.k === 'part' ? SIZE_WORDS : SCOPE_WORDS)[t.s],
      complexity: t.x, needs: t.d || [],
      cost: { cheapest: t.c, balanced: t.b, premium: t.p },
      options: { cheapest: t.o[0], balanced: t.o[1], premium: t.o[2] },
      effort_hours: t.h || null,
      provenance: 'estimate', confidence: t.x >= 5 || type.highLevel ? 'low' : 'medium',
    };
  });
  const stageOf = dependencyStages(items);
  const maxStage = Math.max(...stageOf.values());
  // Priority: required first, then what the most other items wait on, then the earliest stage.
  const dependents = (itemId) => items.filter((i) => i.needs.includes(itemId)).length;
  items.forEach((i) => {
    i.stage = stageOf.get(i.id);
    i.priority = (i.required ? 100 : 0) + dependents(i.id) * 10 + (maxStage - i.stage + 1);
  });

  const systems = [...new Set(items.map((i) => i.system))].map((name) => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '_'), name, items: items.filter((i) => i.system === name).map((i) => i.id) }));
  const stageNames = STAGE_NAMES[type.structure];
  const stages = Array.from({ length: maxStage }, (_, n) => ({
    n: n + 1, name: stageNames[Math.min(n, stageNames.length - 1)],
    items: sortItems(items.filter((i) => i.stage === n + 1), 'priority').map((i) => i.id),
  }));
  const tiers = Object.fromEntries(TIERS.map((tier) => [tier, tierTotals(items, tier)]));
  const complexityAvg = items.reduce((a, i) => a + i.complexity, 0) / items.length;
  const complexity = complexityAvg >= 4 ? 'very high' : complexityAvg >= 3.3 ? 'high' : complexityAvg >= 2.5 ? 'moderate' : 'low';

  const speculative = type.speculative.map(([name, why]) => ({ name, why, provenance: /^fiction/.test(why) ? 'fiction' : 'speculative' }));
  const unmet = asked.filter((r) => !items.some((i) => i.asked && words(r).some((w) => words(`${i.name} ${i.id}`).includes(w.replace(/s$/, '')) || words(`${i.name} ${i.id}`).includes(w))));
  const requirements = [
    ...asked.map((r) => ({ text: r, provenance: 'owner_request', covered: !unmet.includes(r) })),
  ];
  const assumptions = [
    type.structure === 'bill_of_materials' && type.id !== 'building' ? 'One working prototype; production quantities change unit costs.' : 'A first working version, not a finished scaled product.',
    `Prices are US dollar ranges for the ${AS_OF} market, not supplier quotes.`,
    'Cheapest means you do the work with off-the-shelf parts; balanced means good parts and some paid help; premium means top parts and professional work.',
    `Timelines assume about ${HOURS_PER_WEEK.cheapest} hours a week for the cheapest version, ${HOURS_PER_WEEK.balanced} for balanced and ${HOURS_PER_WEEK.premium} for premium.`,
  ];
  const open_questions = [
    'What is the budget ceiling?',
    type.structure === 'bill_of_materials' ? 'One prototype, or a production run, and how many?' : 'Who builds it: you, freelancers or a team?',
    'When do you need it?',
    asked.length ? 'Is anything else a must-have?' : 'Which features or parts are must-haves?',
  ];
  const first = stages[0]?.items.map((itemId) => items.find((i) => i.id === itemId).name) || [];
  const next_actions = [
    `Start with stage 1: ${first.join(', ')}.`,
    'Confirm the budget and quantity so CHE can narrow the ranges.',
    'Get two or three real quotes for the largest cost items before buying.',
  ];
  const risks = [
    ...items.filter((i) => i.complexity >= 5).map((i) => `${i.name} is the hardest part and the most likely to slip.`),
    ...(safety.level !== 'ok' ? safety.notes.slice(0, 1) : []),
  ];

  const plan = {
    ...base,
    objective: text, summary: '', assumptions, requirements, systems, items, stages, tiers,
    complexity, risks, feasibility: type.feasibility, speculative, open_questions, next_actions,
    sources: sources.filter((s) => s && s.url && s.text).map((s) => ({ title: String(s.title), url: String(s.url), text: String(s.text).slice(0, 400), provenance: 'sourced', read_at: s.read_at || now })),
    estimate_basis: { currency: 'USD', as_of: AS_OF, method: METHOD, type: 'range estimate', confidence: type.highLevel ? 'low' : 'medium' },
    unmet_requirements: unmet,
  };
  plan.summary = `${plan.title}: ${an(type.label)}, planned as ${an(STRUCTURES[type.structure])} of ${items.length} items in ${systems.length} groups and ${stages.length} stages.`;
  plan.spoken = speakPlan(plan);
  return plan;
}

/** The plan read aloud: what it is, the three tiers, safety, what is fiction, and the first step. */
export function speakPlan(plan) {
  if (plan.refused) return plan.spoken;
  const t = plan.tiers;
  const lines = [
    `Here is the plan, sir. ${plan.summary}`,
    `Cheapest version about ${costPhrase(t.cheapest)}; balanced about ${costPhrase(t.balanced)}; premium about ${costPhrase(t.premium)}. These are CHE's estimates, not quotes.`,
    `Time: about ${t.balanced.weeks[0]} to ${t.balanced.weeks[1]} weeks for the balanced version. Overall complexity is ${plan.complexity}.`,
    plan.safety.excluded.length ? plan.safety.excluded.join(' ') : '',
    plan.safety.level === 'high_level' ? 'This is a high-level plan for a regulated or safety-critical system.' : '',
    plan.speculative.length ? `Not real today: ${plan.speculative.map((s) => s.name).join('; ')}.` : '',
    plan.unmet_requirements.length ? `Not covered by a real part yet: ${plan.unmet_requirements.join(', ')}.` : '',
    plan.next_actions[0],
    plan.sources.length ? `Background read from ${plan.sources.map((s) => s.title).join(', ')}.` : 'No public source was read for this plan; every figure is an estimate.',
  ];
  return lines.filter(Boolean).join(' ');
}

// ── Research and persistence ────────────────────────────────────────────────────────────────────
/** One public background page for the type (Wikipedia summary). Returns null when it cannot be read. */
export async function researchSource(typeId, { fetchImpl = globalThis.fetch, timeoutMs = 3500, now = new Date().toISOString() } = {}) {
  const type = [...TYPES, PROJECT_TYPE].find((t) => t.id === typeId);
  if (!type?.source || typeof fetchImpl !== 'function') return null;
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${type.source}`;
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'CHE-planner/1 (personal assistant)' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res?.ok) return null;
    const page = await res.json();
    const text = String(page?.extract || '').trim();
    if (!text) return null;
    return { title: `Wikipedia: ${page.title || type.source.replace(/_/g, ' ')}`, url: page?.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${type.source}`, text, read_at: now };
  } catch {
    return null;
  }
}

const INDEX_KEY = 'project_plans_index';
const MAX_PLANS = 30;

/** Saves the plan in its own storage key, keeps an index, and records it in the Brain as a proposal. */
export async function savePlan(storage, store, plan) {
  await storage.put(`project_plan:${plan.id}`, plan);
  const index = (await storage.get(INDEX_KEY)) || [];
  const next = [{ id: plan.id, title: plan.title, type: plan.type, created_at: plan.created_at }, ...index.filter((p) => p.id !== plan.id)];
  for (const old of next.slice(MAX_PLANS)) await storage.delete(`project_plan:${old.id}`);
  await storage.put(INDEX_KEY, next.slice(0, MAX_PLANS));
  if (!store || plan.refused) return null;
  const body = [
    plan.summary,
    `Request: ${plan.request}`,
    `Estimates (${plan.estimate_basis.method}): cheapest ${costPhrase(plan.tiers.cheapest)}; balanced ${costPhrase(plan.tiers.balanced)}; premium ${costPhrase(plan.tiers.premium)}.`,
    `Stages: ${plan.stages.map((s) => `${s.n}. ${s.name}`).join('; ')}.`,
    plan.safety.excluded.join(' '),
    plan.speculative.length ? `Speculative or fiction: ${plan.speculative.map((s) => `${s.name} (${s.why})`).join('; ')}.` : '',
    ...plan.sources.map((s) => `Source read: ${s.title} ${s.url}`),
  ].filter(Boolean).join('\n');
  return store.put({
    id: `project_plan:${plan.id}`, kind: 'project_plan', region: BRAIN_REGIONS.projects, path: plan.type_label,
    title: `Plan: ${plan.title}`, body, verification: 'proposed', created_at: plan.created_at,
    source: { store: 'project_plans', id: plan.id, type: plan.type, structure: plan.structure, method: plan.estimate_basis.method, sources: plan.sources.map((s) => s.url), route: PLAN_SOURCE },
  });
}

export async function loadPlan(storage, id) {
  if (id) return (await storage.get(`project_plan:${id}`)) || null;
  const index = (await storage.get(INDEX_KEY)) || [];
  return index[0] ? (await storage.get(`project_plan:${index[0].id}`)) || null : null;
}

export async function listPlans(storage) {
  return (await storage.get(INDEX_KEY)) || [];
}

// ── Follow-ups on the latest plan ───────────────────────────────────────────────────────────────
const FOLLOW = /^(?:sort|order|rank|list|show\s+me|read(?:\s+me)?|what(?:'s|\s+is|\s+are)|which|give\s+me|compare|how\s+much|tell\s+me|render)\b/i;
// Only questions that name the plan or its parts: "what are the risks of Tesla" is not about the plan.
const PLAN_NOUN = /\b(?:parts|components|pieces|items|features|assets|dependenc\w*|bill\s+of\s+materials|boms?|tiers|stages|happen\s+first|comes?\s+first|possible\s+today|(?:the|this)\s+(?:plan|project|build|design|prototype)|(?:cheapest|realistic|balanced|premium|luxury)\s+(?:to\s+most\s+expensive\s+)?versions?)\b/i;
const SORT_WORDS = [
  ['size', /smallest|biggest|largest|by\s+size/i],
  ['complexity', /simplest|most\s+complex|complexity/i],
  ['cost', /cheapest\s+to|most\s+expensive|by\s+(?:cost|price)/i],
  ['priority', /priority|most\s+important/i],
  ['required', /required|optional/i],
  ['dependency', /dependenc|happen\s+first|comes?\s+first|order\s+(?:of|to)\s+(?:build|do)/i],
];

/** A question about the latest plan, or null: { kind: 'sort', by } | { kind: 'cost' | 'safety' | 'speculative' | 'sources' }. */
export function planFollowUpIntent(message) {
  const body = String(message || '').trim().replace(WAKE, '').trim();
  if (!FOLLOW.test(body) || !PLAN_NOUN.test(body) || NOT_PLAN.test(body)) return null;
  const sort = SORT_WORDS.find(([, re]) => re.test(body));
  if (sort) return { kind: 'sort', by: sort[0] };
  if (/possible\s+today|speculative|real\s+(?:today|vs|versus)|fiction/i.test(body)) return { kind: 'speculative' };
  if (/safety|risks?|legal/i.test(body)) return { kind: 'safety' };
  if (/sources?/i.test(body)) return { kind: 'sources' };
  if (/cost|how\s+much|tiers?|cheapest|total/i.test(body)) return { kind: 'cost' };
  return { kind: 'sort', by: 'dependency' };
}

const unitWord = (per) => (per === 'unit' ? ' per unit' : per === 'month' ? ' a month' : '');

/** The spoken answer to a follow-up, from the plan's own data. */
export function answerPlanFollowUp(plan, intent, { tier = 'balanced' } = {}) {
  if (!plan || plan.refused) return 'There is no plan to read yet, sir. Ask me to plan something first.';
  if (intent.kind === 'sort') {
    const list = sortItems(plan.items, intent.by, tier);
    const head = intent.by === 'dependency'
      ? plan.stages.map((s) => `Stage ${s.n}, ${s.name}: ${s.items.map((itemId) => plan.items.find((i) => i.id === itemId).name).join(', ')}.`).join(' ')
      : list.map((i, n) => `${n + 1}. ${i.name}${intent.by === 'cost' ? `, ${money(i.cost[tier])}${unitWord(i.per)}` : intent.by === 'size' ? `, ${i.size_label}` : intent.by === 'complexity' ? `, complexity ${i.complexity} of 5` : intent.by === 'required' ? (i.required ? ', required' : ', optional') : ''}.`).join(' ');
    return `${plan.title}, ${SORTS[intent.by]}${intent.by === 'cost' ? `, ${tier} prices, CHE's estimates` : ''}: ${head}`;
  }
  if (intent.kind === 'cost') {
    const t = plan.tiers;
    return `${plan.title}: cheapest about ${costPhrase(t.cheapest)}, ${t.cheapest.weeks[0]} to ${t.cheapest.weeks[1]} weeks; balanced about ${costPhrase(t.balanced)}, ${t.balanced.weeks[0]} to ${t.balanced.weeks[1]} weeks; premium about ${costPhrase(t.premium)}, ${t.premium.weeks[0]} to ${t.premium.weeks[1]} weeks. Required items only. These are CHE's estimates (${plan.estimate_basis.method}), not quotes.`;
  }
  if (intent.kind === 'safety') {
    return [`Safety and rules for ${plan.title}:`, ...plan.safety.excluded, ...plan.safety.notes, ...plan.risks].join(' ') || 'No special safety rules for this plan, sir.';
  }
  if (intent.kind === 'speculative') {
    return plan.speculative.length
      ? `Real today: every item in the plan uses parts or services that exist now. Not real today: ${plan.speculative.map((s) => `${s.name}, ${s.why}`).join('; ')}.`
      : `Everything in the plan for ${plan.title} uses parts or services that exist today, sir. ${plan.feasibility}`;
  }
  if (intent.kind === 'sources') {
    return plan.sources.length
      ? `Sources read for ${plan.title}: ${plan.sources.map((s) => `${s.title}, ${s.url}`).join('; ')}. The costs are CHE's estimates, not from these pages.`
      : `No public source was read for ${plan.title}, sir; every figure is CHE's estimate (${plan.estimate_basis.method}).`;
  }
  return null;
}
