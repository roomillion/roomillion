(function (global) {
  "use strict";

  function assertThree() {
    if (!global.THREE) throw new Error("game.assets@1 需要 graphics.three@1");
    return global.THREE;
  }

  function material(color, options = {}) {
    const THREE = assertThree();
    return new THREE.MeshStandardMaterial({ color, roughness: options.roughness ?? 0.7, metalness: options.metalness ?? 0.05, emissive: options.emissive ?? 0x000000, emissiveIntensity: options.emissiveIntensity ?? 0 });
  }

  function player(color) {
    const THREE = assertThree();
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.55, 24, 16), material(color, { roughness: 0.35, metalness: 0.18 }));
    body.castShadow = true;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.12), material(0xdffaff, { metalness: 0.5, emissive: 0x4dc9ff, emissiveIntensity: 0.35 }));
    visor.position.set(0, 0.08, -0.49);
    group.add(body, visor);
    return group;
  }

  function collectible(color) {
    const THREE = assertThree();
    const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.42, 0), material(color, { roughness: 0.2, metalness: 0.35, emissive: color, emissiveIntensity: 0.32 }));
    mesh.castShadow = true;
    return mesh;
  }

  function obstacle(width, height, depth, color) {
    const THREE = assertThree();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material(color));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  global.ZhibianGameAssets = Object.freeze({ material, player, collectible, obstacle });
})(globalThis);
