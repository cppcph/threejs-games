// 可复用海面模块入口
export { WindSeaModel, beaufort, seaStateScale, whitecapCoverage, waveSpeeds, wavenumber, depthLimitation, X_FD } from './WindSeaModel.js';
export { OceanSimulation, DEFAULT_CASCADES } from './OceanSimulation.js';
export { buildOceanGeometry, OCEAN_GRID_PRESETS } from './OceanGeometry.js';
export { createOceanMaterial, OCEAN_LOOK } from './OceanMaterial.js';
export { Ocean, OCEAN_QUALITY } from './Ocean.js';
export { Buoyancy } from './Buoyancy.js';
export { makeFoamTexture, makeRippleTexture } from './textures.js';
export { FoamField, FOAM_TIMESCALES } from './FoamField.js';
export { Spray, SpumeEmitter } from './Spray.js';
export { airSeaRoughness, windAtHeight, relaxationTime, stepDroplet } from './droplets.js';
