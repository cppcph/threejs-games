// 帆船动力学模块入口（纯 JS，不依赖 three.js；画面适配见 ./three-adapter.js）
export { SailingYacht, YACHT_DEFAULTS, MOTOR_DEFAULTS, GROUND_DEFAULTS, wakeAngle } from './SailingYacht.js';
export { HullShape, HULL_DEFAULTS, YACHT_HULL, sailboatLayout } from './HullShape.js';
export { buildYachtMesh, buildHull, buildSlab, meshProperties, TAG } from './HullMesh.js';
export { HullIntegrator, staticLoads, equilibrium, stabilityCurve, matFromYXZ } from './Hydrostatics.js';
export { ittc57, hullFormParameters, ResiduaryResistance, DSYHS_2008, WATER, HULL_FORM_FACTOR } from './Resistance.js';
export { Foil, helmbold, chordAt, submergedPlanform } from './Foils.js';
export { Rig, rigFromLayout, windProfile, windage, ORC_SAIL_COEFFS, ORC_KHEFF, ORC_FCDMULT, AIR } from './Sails.js';
export { Autopilot, wrap } from './Autopilot.js';
