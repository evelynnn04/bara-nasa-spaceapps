// The forest: terrain carved by a jungle river, the river itself, real trees along the flight
// corridor, and beyond them a continuous rainforest canopy surface (individual crowns, lit as domes),
// so the land reads as unbroken jungle from the air. Everything burns by the same rule: a point
// ignites when the shared fire clock passes igniteTime(x, z) (common.ts).
// Burn stages, in fire-clock units after ignition: 0–0.4 scorch, 0.2–1.4 flames, leaves burn away by
// ~1.6, then char; embers in the ground glow for a few units more.

import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, Group, PlaneGeometry, InstancedBufferAttribute, InstancedMesh, Matrix4, Mesh,
  MeshDepthMaterial, MeshStandardMaterial, Object3D, RGBADepthPacking, ShaderMaterial, UniformsLib, UniformsUtils,
  Vector3, type Material, type Texture,
} from "three";
import { FOREST_HALF, groundY, igniteTime, ORIGINS, RIVER_HALF, riverX, rng, WATER_Y, WORLD_GLSL } from "./common";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { barkTexture, fernTexture, frondTexture, groundTexture, leafClusterTexture } from "./textures";
import { buildModels, type Species } from "./trees";

export interface TreeSite { x: number; z: number; ground: number; crownY: number; crownR: number; ignite: number; species: Species }

export interface Forest {
  group: Group;
  trees: TreeSite[];
  uniforms: { uTime: { value: number }; uFireClock: { value: number }; uOrigins: { value: Vector3[] }; uWind: { value: number } };
  water: { uSky: { value: Color }; uSunDir: { value: Vector3 } };
}

/** Terrain extent (world z runs from Z_NEAR to Z_FAR; the flight heads towards −z). */
export const Z_NEAR = 1800, Z_FAR = -7800;
/** Real trees grow between these z values: the stretch the low flight passes through. */
const TREES_Z0 = 280, TREES_Z1 = -2750;

const BURN_GLSL = /* glsl */ `
  uniform float uFireClock;
  uniform float uTime;
  ${WORLD_GLSL}
  vec3 fireGlow(float local, vec2 seed) {
    float band = smoothstep(0.0, 0.25, local) * (1.0 - smoothstep(1.2, 3.5, local));
    float flick = 0.6 + 0.4 * sin(uTime * 7.0 + seed.x * 0.37 + seed.y * 0.21) * sin(uTime * 3.3 + seed.y * 0.13);
    return vec3(1.0, 0.35, 0.06) * band * flick;
  }
`;

function patchBurn(mat: MeshStandardMaterial, part: "wood" | "leaves" | "ground", u: Forest["uniforms"]): void {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    const instanced = part !== "ground";
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>
        ${instanced ? "attribute float aIgnite; attribute float aTint;" : ""}
        uniform float uTime; uniform float uWind;
        varying float vIgnite; varying float vTint; varying vec3 vW; varying float vLocalY;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vLocalY = position.y;
        ${instanced ? `
          vec3 iPos = instanceMatrix[3].xyz;
          vIgnite = aIgnite; vTint = aTint;
          float sway = sin(uTime * 1.1 + iPos.x * 0.05 + iPos.z * 0.07) + 0.5 * sin(uTime * 2.3 + iPos.z * 0.11);
          transformed.xz += vec2(0.8, 0.35) * sway * uWind * pow(max(position.y, 0.0) / 30.0, 1.4);
          ${part === "leaves" ? "transformed += normal * sin(uTime * 4.0 + position.x * 3.0 + position.z * 2.0) * 0.06 * uWind;" : ""}`
          : "vIgnite = 0.0; vTint = 0.0;"}`)
      .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>
        vec4 wp4 = vec4(transformed, 1.0);
        ${instanced ? "wp4 = instanceMatrix * wp4;" : ""}
        vW = (modelMatrix * wp4).xyz;`);

    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
        varying float vIgnite; varying float vTint; varying vec3 vW; varying float vLocalY;
        ${BURN_GLSL}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        float ign = ${part === "ground" ? "igniteTime(vW.xz)" : "vIgnite"};
        float local = uFireClock - ign;
        ${part === "leaves" ? `
          diffuseColor.rgb *= 0.9 + vTint * 0.25;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.26, 0.07) * (0.6 + diffuseColor.g), smoothstep(-0.15, 0.35, local));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.035, 0.03), smoothstep(0.9, 1.6, local));
          float holes = h21(floor(vMapUv * 9.0) + vec2(vIgnite * 13.0));
          if (local > 0.35 && holes < smoothstep(0.35, 1.7, local)) discard;`
        : part === "wood" ? `
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.035, 0.03, 0.028), smoothstep(0.25, 1.6, local) * smoothstep(-2.0, 18.0, vLocalY + 6.0 * local));`
          : `
          float ash = smoothstep(-0.1, 1.2, local);
          vec3 burnt = mix(vec3(0.06, 0.05, 0.045), vec3(0.32, 0.31, 0.3), smoothstep(0.62, 0.9, fbm(vW.xz * 0.15)) * smoothstep(4.0, 12.0, local));
          diffuseColor.rgb = mix(diffuseColor.rgb, burnt, ash);`}`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        ${part === "leaves" ? "totalEmissiveRadiance += fireGlow(local, vW.xz) * 2.6 * (1.0 - smoothstep(1.1, 1.6, local));"
          : part === "wood" ? "totalEmissiveRadiance += fireGlow(local - 0.3, vW.xz) * 1.8 * step(0.55, fbm(vW.xz * 2.0 + vec2(vLocalY * 1.7, 0.0)));"
            : "totalEmissiveRadiance += fireGlow(local, vW.xz) * 2.2 * smoothstep(0.45, 0.8, fbm(vW.xz * 0.35 + uTime * 0.05));"}`);
  };
  mat.customProgramCacheKey = () => `burn-${part}`;
}

export function buildForest(small: boolean, shadows: boolean): Forest {
  const group = new Group();
  const uniforms: Forest["uniforms"] = {
    uTime: { value: 0 }, uFireClock: { value: 0 }, uWind: { value: 1 },
    uOrigins: { value: ORIGINS.map(([x, z, t]) => new Vector3(x, z, t)) },
  };
  const R = rng(42);

  // ---------------------------------------------------------------- terrain, gridded around the river
  // Columns are spaced in river-relative distance, fine near the water and coarse far away, so the
  // channel and banks are smooth where the camera is low without millions of vertices elsewhere.
  const cols = small ? 180 : 280, step = small ? 18 : 12;
  const rows = Math.floor((Z_NEAR - Z_FAR) / step) + 1;
  const off = (u: number) => Math.sign(u) * Math.abs(u) ** 2.3 * 4800;
  const n = (cols + 1) * rows;
  const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), col = new Float32Array(n * 3), dist = new Float32Array(n);
  for (let j = 0; j < rows; j++) {
    const z = Z_NEAR - j * step, rx = riverX(z);
    for (let i = 0; i <= cols; i++) {
      const k = j * (cols + 1) + i;
      const d = off(i / cols * 2 - 1), x = rx + d, y = groundY(x, z);
      pos.set([x, y, z], k * 3);
      uv.set([x / 7, z / 7], k * 2);
      dist[k] = Math.abs(d);
      const wet = Math.max(0, 1 - (Math.abs(d) - RIVER_HALF) / 18);
      const v = 0.78 + R() * 0.22;
      col.set([v * 0.72 * (1 - wet * 0.3), v * 0.9 * (1 - wet * 0.35), v * 0.6 * (1 - wet * 0.45)], k * 3);   // mossy, darker by the water
    }
  }
  const idx = new Uint32Array(cols * (rows - 1) * 6);
  let q = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i, b = a + cols + 1;
      idx.set([a, a + 1, b, a + 1, b + 1, b], q);   // counter-clockwise from above
      q += 6;
    }
  }
  const tGeo = new BufferGeometry();
  tGeo.setAttribute("position", new BufferAttribute(pos, 3));
  tGeo.setAttribute("uv", new BufferAttribute(uv, 2));
  tGeo.setAttribute("color", new BufferAttribute(col, 3));
  tGeo.setAttribute("aRiver", new BufferAttribute(dist, 1));
  tGeo.setIndex(new BufferAttribute(idx, 1));
  tGeo.computeVertexNormals();

  const groundMat = new MeshStandardMaterial({ map: groundTexture(), vertexColors: true, roughness: 0.97 });
  patchBurn(groundMat, "ground", uniforms);
  const terrain = new Mesh(tGeo, groundMat);
  terrain.receiveShadow = shadows;
  group.add(terrain);

  // ---------------------------------------------------------------- canopy surface beyond the corridor
  const canopyMat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, side: DoubleSide });
  canopyMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>
        attribute float aRiver; varying float vRiver; varying vec3 vW;
        ${BURN_GLSL}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vRiver = aRiver;
        float local = uFireClock - igniteTime(transformed.xz);
        float h = 30.0 + 9.0 * fbm(transformed.xz * 0.004) ;
        transformed.y += h * (1.0 - 0.82 * smoothstep(0.6, 3.0, local));`)
      .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>
        vW = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
        varying float vRiver; varying vec3 vW;
        ${BURN_GLSL}
        // Worley crowns: each cell is one tree crown, shaded as a dome.
        vec4 crown(vec2 p) {
          vec2 i = floor(p), f = fract(p); float d1 = 9.0, d2 = 9.0; vec2 best = vec2(0.0), id = vec2(0.0);
          for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
            vec2 g = vec2(float(x), float(y));
            vec2 o = vec2(h21(i + g), h21(i + g + 17.31)) * 0.85 + 0.075;
            vec2 r = g + o - f; float d = dot(r, r);
            if (d < d1) { d2 = d1; d1 = d; best = r; id = i + g; } else if (d < d2) d2 = d;
          }
          return vec4(best, sqrt(d1), h21(id * 1.7));
        }`)
      .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
        // Cut the canopy surface away only where real trees stand (their stretch of the river); elsewhere
        // it runs right up to the banks.
        float zone = smoothstep(${(TREES_Z0 + 40).toFixed(1)}, ${(TREES_Z0 - 60).toFixed(1)}, vW.z) * smoothstep(${(TREES_Z1 - 40).toFixed(1)}, ${(TREES_Z1 + 60).toFixed(1)}, vW.z);
        float edge = mix(${(28).toFixed(1)}, ${(FOREST_HALF - 45).toFixed(1)} + 40.0 * vnoise(vW.xz * 0.02), zone);
        if (vRiver < edge) discard;`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        vec4 c1 = crown(vW.xz / 9.0);
        vec4 c2 = crown(vW.xz / 23.0 + 5.3);
        float big = step(0.86, c2.w) * smoothstep(0.75, 0.2, c2.z);           // emergent crowns
        vec4 c = big > 0.5 ? c2 : c1;
        float t = c.w;
        vec3 green = t < 0.33 ? vec3(0.07, 0.16, 0.05) : t < 0.66 ? vec3(0.11, 0.22, 0.06) : t < 0.93 ? vec3(0.05, 0.13, 0.05) : vec3(0.22, 0.27, 0.09);
        green *= 0.75 + 0.5 * fbm(vW.xz * 0.6);
        float gap = smoothstep(0.55, 0.85, c.z);
        green = mix(green, vec3(0.02, 0.04, 0.02), gap);
        float local = uFireClock - igniteTime(vW.xz);
        green = mix(green, vec3(0.3, 0.18, 0.06), smoothstep(-0.05, 0.45, local) * (0.6 + 0.4 * fbm(vW.xz * 0.02)));
        green = mix(green, mix(vec3(0.05, 0.045, 0.04), vec3(0.3, 0.29, 0.28), smoothstep(0.6, 0.85, fbm(vW.xz * 0.05)) * smoothstep(5.0, 15.0, local)), smoothstep(0.9, 2.2, local));
        diffuseColor.rgb = green;
        vec3 domeN = normalize(vec3(-c.x * 1.4, 0.55 + (1.0 - c.z) * 0.6, -c.y * 1.4));`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
        normal = normalize((viewMatrix * vec4(mix(domeN, vec3(0.0, 1.0, 0.0), smoothstep(1.0, 2.5, uFireClock - igniteTime(vW.xz))), 0.0)).xyz);`)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        float lc = uFireClock - igniteTime(vW.xz);
        // a real front is patchy: flare-ups, gaps, smouldering stretches, all shifting
        float patchy = smoothstep(0.32, 0.78, fbm(vW.xz * 0.012 + vec2(uTime * 0.03, -uTime * 0.02))) * 0.85 + 0.15;
        float flare = 1.4 + 2.6 * smoothstep(0.45, 0.85, fbm(vW.xz * 0.06 + uTime * 0.25));
        totalEmissiveRadiance += fireGlow(lc, vW.xz) * patchy * flare * (1.0 - smoothstep(1.4, 3.5, lc) * 0.75);`);
  };
  canopyMat.customProgramCacheKey = () => "canopy";
  const canopy = new Mesh(tGeo, canopyMat);
  canopy.receiveShadow = false;
  group.add(canopy);

  // ---------------------------------------------------------------- the river
  const wSegs = Math.floor((Z_NEAR - Z_FAR) / 8);
  const wPos = new Float32Array((wSegs + 1) * 2 * 3);
  for (let j = 0; j <= wSegs; j++) {
    const z = Z_NEAR - j * 8, x = riverX(z);
    wPos.set([x - RIVER_HALF - 8, WATER_Y, z, x + RIVER_HALF + 8, WATER_Y, z], j * 6);
  }
  const wIdx: number[] = [];
  for (let j = 0; j < wSegs; j++) { const a = j * 2; wIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const wGeo = new BufferGeometry();
  wGeo.setAttribute("position", new BufferAttribute(wPos, 3));
  wGeo.setIndex(wIdx);
  const water = { uSky: { value: new Color(0x9fb6c0) }, uSunDir: { value: new Vector3(0.3, 0.4, -0.8).normalize() } };
  const waterMat = new ShaderMaterial({
    fog: true,
    uniforms: UniformsUtils.merge([UniformsLib.fog, { uTime: { value: 0 }, uFireClock: { value: 0 }, uOrigins: { value: [] } }]),
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      varying vec3 vW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
        vec4 mvPosition = viewMatrix * w;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <fog_pars_fragment>
      uniform vec3 uSky; uniform vec3 uSunDir;
      ${BURN_GLSL}
      varying vec3 vW;
      void main() {
        // Gentle current ripples: smooth waves plus slow noise, flowing downstream (−z).
        vec2 q = vW.xz * 0.22;
        float e = 0.35;
        #define WAVE(Q) (0.5 * sin((Q).x * 0.9 + uTime * 0.7 + (Q).y * 0.2) + 0.5 * sin((Q).y * 1.4 + uTime * 1.6 + (Q).x * 0.45) + 1.4 * fbm((Q) * 0.45 + vec2(0.0, uTime * 0.18)))
        float h0 = WAVE(q), hx = WAVE(q + vec2(e, 0.0)), hz = WAVE(q + vec2(0.0, e));
        vec3 n = normalize(vec3((h0 - hx) * 0.22, 1.0, (h0 - hz) * 0.22));
        vec3 v = normalize(cameraPosition - vW);
        float fres = 0.05 + 0.95 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
        // what the water mirrors: sky down the middle, the dark wall of forest towards each bank
        float edge = abs(vW.x + n.x * 6.0 - riverX(vW.z)) / ${RIVER_HALF.toFixed(1)};
        vec3 refl = mix(uSky * 0.8, vec3(0.025, 0.04, 0.02), smoothstep(0.15, 0.85, edge));
        vec3 deep = vec3(0.055, 0.06, 0.032);
        vec3 col = mix(deep, refl, 0.25 + fres * 0.7);
        vec3 hv = normalize(uSunDir + v);
        col += vec3(1.0, 0.9, 0.75) * pow(max(dot(n, hv), 0.0), 220.0) * 1.1 * (1.0 - smoothstep(0.3, 0.9, edge));
        float lc = uFireClock - igniteTime(vW.xz + vec2(40.0, 0.0));
        col += vec3(1.0, 0.4, 0.1) * 0.35 * smoothstep(0.0, 0.5, lc) * (1.0 - smoothstep(1.5, 5.0, lc)) * fres;   // fire on the banks, reflected
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  waterMat.uniforms.uTime = uniforms.uTime;
  waterMat.uniforms.uFireClock = uniforms.uFireClock;
  waterMat.uniforms.uOrigins = uniforms.uOrigins;
  waterMat.uniforms.uSky = water.uSky;
  waterMat.uniforms.uSunDir = water.uSunDir;
  group.add(new Mesh(wGeo, waterMat));

  // ---------------------------------------------------------------- the trees
  const models = buildModels();
  const leafTex: Texture[] = [leafClusterTexture(1), leafClusterTexture(2, 14), frondTexture(3)];
  const bark = barkTexture();
  const woodMat = new MeshStandardMaterial({ map: bark, vertexColors: true, roughness: 0.95 });
  patchBurn(woodMat, "wood", uniforms);
  const leafMats = leafTex.map((t) => {
    const m = new MeshStandardMaterial({ map: t, vertexColors: true, roughness: 0.82, alphaTest: 0.42, side: DoubleSide, alphaToCoverage: true });
    patchBurn(m, "leaves", uniforms);
    return m;
  });
  const leafDepth = leafTex.map((t) => new MeshDepthMaterial({ depthPacking: RGBADepthPacking, map: t, alphaTest: 0.42 }));

  // Where trees grow: a jittered grid over the corridor, species by distance from the water.
  const cell = small ? 11 : 7.6;
  const trees: TreeSite[] = [];
  const perModel: { m: Matrix4; site: TreeSite; tint: number }[][][] = [];   // [chunk][model][]
  const CHUNK = 300;
  const e = new Object3D();
  for (let z = TREES_Z0; z > TREES_Z1; z -= cell) {
    const rx = riverX(z);
    for (let d = -FOREST_HALF; d <= FOREST_HALF; d += cell) {
      const jd = d + (R() - 0.5) * cell * 0.9, jz = z + (R() - 0.5) * cell * 0.9;
      const ad = Math.abs(jd);
      if (ad < RIVER_HALF + 2) continue;
      const x = rx + jd;
      const u = R();
      // banks: palms and shrubs lean out over the water; inland: canopy trees with scattered emergents
      const mi = ad < RIVER_HALF + 22
        ? (u < 0.42 ? 5 + Math.floor(R() * 2) : u < 0.78 ? 7 + Math.floor(R() * 2) : 2 + Math.floor(R() * 3))
        : (u < 0.09 ? Math.floor(R() * 2) : u < 0.62 ? 2 + Math.floor(R() * 3) : u < 0.76 ? 5 + Math.floor(R() * 2) : 7 + Math.floor(R() * 2));
      const ground = groundY(x, jz);
      const s = 0.82 + R() * 0.4;
      e.position.set(x, ground, jz);
      e.rotation.set(0, R() * Math.PI * 2, 0);
      if (ad < RIVER_HALF + 22 && models[mi].species === "palm") e.rotation.z = (jd > 0 ? 1 : -1) * (0.08 + R() * 0.18);  // lean over the river
      e.scale.setScalar(s);
      e.updateMatrix();
      const site: TreeSite = { x, z: jz, ground, crownY: ground + models[mi].crownY * s, crownR: models[mi].crownR * s,
        ignite: igniteTime(x, jz) + (R() - 0.5) * 0.6, species: models[mi].species };
      trees.push(site);
      const ci = Math.floor((TREES_Z0 - jz) / CHUNK);
      perModel[ci] ??= models.map(() => []);
      perModel[ci][mi].push({ m: e.matrix.clone(), site, tint: R() });
    }
  }

  for (const chunk of perModel) {
    if (!chunk) continue;
    chunk.forEach((list, mi) => {
      if (!list.length) return;
      const model = models[mi];
      const parts: [BufferGeometry, Material, "wood" | "leaves"][] = [[model.wood.clone(), woodMat, "wood"], [model.leaves.clone(), leafMats[model.foliage], "leaves"]];
      for (const [geo, mat, part] of parts) {
        geo.setAttribute("aIgnite", new InstancedBufferAttribute(new Float32Array(list.map((t) => t.site.ignite)), 1));
        geo.setAttribute("aTint", new InstancedBufferAttribute(new Float32Array(list.map((t) => t.tint)), 1));
        const mesh = new InstancedMesh(geo, mat, list.length);
        list.forEach((t, i) => mesh.setMatrixAt(i, t.m));
        mesh.computeBoundingSphere();
        mesh.castShadow = shadows;
        mesh.receiveShadow = shadows;
        if (part === "leaves") mesh.customDepthMaterial = leafDepth[model.foliage];
        group.add(mesh);
      }
    });
  }

  // ---------------------------------------------------------------- ground cover: ferns to the water's edge
  const fernParts = [0, 1, 2].map((k) => {
    const g = new PlaneGeometry(1, 1);
    g.translate(0, 0.5, 0);
    g.rotateX(-0.25);
    g.rotateY((k * Math.PI) / 3);
    const nrm = g.attributes.normal as BufferAttribute;
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);           // lit like a soft mound
    return g;
  });
  const fernGeo = mergeGeometries(fernParts)!;
  const fernMat = new MeshStandardMaterial({ map: fernTexture(8), roughness: 0.85, alphaTest: 0.45, side: DoubleSide, alphaToCoverage: true });
  patchBurn(fernMat, "leaves", uniforms);
  const fernStep = small ? 3.8 : 2.5;
  const ferns: { m: Matrix4; ign: number; tint: number }[][] = [];
  for (let z = TREES_Z0; z > TREES_Z1; z -= fernStep) {
    const rx = riverX(z);
    for (let d = -150; d <= 150; d += fernStep) {
      const jd = d + (R() - 0.5) * fernStep, jz = z + (R() - 0.5) * fernStep;
      const ad = Math.abs(jd);
      if (ad < RIVER_HALF - 0.5 || R() < ad / 260) continue;               // thickest along the banks
      const x = rx + jd, y = groundY(x, jz);
      if (y < WATER_Y + 0.2) continue;
      e.position.set(x, y - 0.1, jz);
      e.rotation.set(0, R() * Math.PI * 2, 0);
      const s = (ad < RIVER_HALF + 14 ? 3.2 : 1.6) + R() * 2.2;
      e.scale.set(s * 1.3, s, s * 1.3);
      e.updateMatrix();
      const ci = Math.floor((TREES_Z0 - jz) / CHUNK);
      (ferns[ci] ??= []).push({ m: e.matrix.clone(), ign: igniteTime(x, jz) - 0.2 + R() * 0.3, tint: R() });
    }
  }
  for (const list of ferns) {
    if (!list?.length) continue;
    const geo = fernGeo.clone();
    geo.setAttribute("aIgnite", new InstancedBufferAttribute(new Float32Array(list.map((f) => f.ign)), 1));
    geo.setAttribute("aTint", new InstancedBufferAttribute(new Float32Array(list.map((f) => f.tint)), 1));
    const mesh = new InstancedMesh(geo, fernMat, list.length);
    list.forEach((f, i) => mesh.setMatrixAt(i, f.m));
    mesh.computeBoundingSphere();
    mesh.receiveShadow = shadows;
    group.add(mesh);
  }

  return { group, trees, uniforms, water };
}
