import * as THREE from "three";
import type {
  Balance,
  BuildingKind,
  EntitySnapshot,
  GameMap,
  SimEvent,
  Snapshot,
  Team,
  UnitKind,
  NodeKind,
} from "../shared/types.js";
import { Rng, decodeBase64 } from "../shared/rng.js";

const TEAM_COLORS: Record<number, { main: number; light: number; dark: number; accent: number }> = {
  0: { main: 0x3f7fd6, light: 0xa8c9ff, dark: 0x1d3a63, accent: 0x7fe3ff },
  1: { main: 0xd2563f, light: 0xffb08f, dark: 0x5c241b, accent: 0xffc861 },
  2: { main: 0x8a8f98, light: 0xc7ccd4, dark: 0x3b3f46, accent: 0xd8b25c },
};

interface EntityView {
  group: THREE.Group;
  model: THREE.Group;
  eid: number;
  team: Team;
  kind: "u" | "b";
  type: string;
  height: number;
  bar?: { group: THREE.Group; fill: THREE.Mesh };
  ring?: THREE.Mesh;
  hp: number;
  maxHp: number;
  targetX: number;
  targetY: number;
  x: number;
  y: number;
  done: boolean;
  progress: number;
  level: number;
  spin?: THREE.Object3D;
  bobPhase: number;
  selected: boolean;
  removeIn: number | null;
}

interface Effect {
  object: THREE.Object3D;
  life: number;
  max: number;
  update: (t: number, object: THREE.Object3D) => void;
}

export interface SceneSnapshotMeta {
  entities: EntitySnapshot[];
  youTeam: Team;
}

export class SceneView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly raycaster = new THREE.Raycaster();
  readonly target = new THREE.Vector3(100, 0, 39);
  zoom = 56;

  private readonly canvas: HTMLCanvasElement;
  private readonly map: GameMap;
  private readonly balance: Balance;
  private readonly views = new Map<number, EntityView>();
  private readonly effectList: Effect[] = [];
  private readonly groundPlane: THREE.Plane;
  private readonly selection = new Set<number>();
  private fogMesh: THREE.Mesh;
  private fogTexture: THREE.CanvasTexture;
  private fogCanvas: HTMLCanvasElement;
  private fogTmp: HTMLCanvasElement;
  private minimapBase: HTMLCanvasElement;
  private sun: THREE.DirectionalLight;
  private snapshot: Snapshot | null = null;
  private cameraTargetGoal = new THREE.Vector3(100, 0, 39);

  constructor(canvas: HTMLCanvasElement, map: GameMap, balance: Balance) {
    this.canvas = canvas;
    this.map = map;
    this.balance = balance;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene.background = new THREE.Color("#0b1419");
    this.scene.fog = new THREE.Fog("#0b1419", 110, 210);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, 500);
    this.camera.position.set(100, 45, 90);

    const hemi = new THREE.HemisphereLight(0xbcd7ff, 0x26301f, 1.35);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xffe6b8, 2.1);
    this.sun.position.set(65, 95, 35);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -80;
    this.sun.shadow.camera.right = 80;
    this.sun.shadow.camera.top = 80;
    this.sun.shadow.camera.bottom = -80;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 240;
    this.sun.shadow.bias = -0.0008;
    this.sun.target.position.set(map.width / 2, 0, map.height / 2);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    const ground = this.buildTerrain();
    this.scene.add(ground);
    this.buildDecor();
    this.buildMountains();
    this.buildBaseDecor();

    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this.fogCanvas = document.createElement("canvas");
    this.fogCanvas.width = 4;
    this.fogCanvas.height = 4;
    this.fogTmp = document.createElement("canvas");
    this.fogTexture = new THREE.CanvasTexture(this.fogCanvas);
    this.fogTexture.minFilter = THREE.LinearFilter;
    this.fogTexture.magFilter = THREE.LinearFilter;
    const fogGeo = new THREE.PlaneGeometry(map.width + 4, map.height + 4);
    fogGeo.rotateX(-Math.PI / 2);
    this.fogMesh = new THREE.Mesh(
      fogGeo,
      new THREE.MeshBasicMaterial({
        map: this.fogTexture,
        transparent: true,
        depthWrite: false,
        opacity: 0.98,
      }),
    );
    this.fogMesh.position.set(map.width / 2, 7, map.height / 2);
    this.fogMesh.renderOrder = 20;
    this.scene.add(this.fogMesh);

    this.minimapBase = this.buildMinimapBase();
    this.resize();
    window.addEventListener("resize", this.resize);
  }

  dispose(): void {
    window.removeEventListener("resize", this.resize);
    this.renderer.dispose();
  }

  private resize = (): void => {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  };

  // --------------------------------------------------------------- terrain

  private buildTerrain(): THREE.Mesh {
    const geometry = new THREE.PlaneGeometry(this.map.width, this.map.height, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: 0x30492d,
        roughness: 1,
        metalness: 0,
        flatShading: true,
      }),
    );
    mesh.position.set(this.map.width / 2, 0, this.map.height / 2);
    mesh.receiveShadow = true;

    const rng = new Rng(this.map.seed ^ 0x51ed);
    const patches = [
      new THREE.Color(0x37522f),
      new THREE.Color(0x2b4429),
      new THREE.Color(0x3a5733),
      new THREE.Color(0x314c2c),
    ];
    for (let i = 0; i < 90; i++) {
      const radius = rng.range(3, 13);
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(radius, 7),
        new THREE.MeshStandardMaterial({
          color: patches[rng.int(0, patches.length - 1)]!,
          roughness: 1,
          flatShading: true,
        }),
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(
        rng.range(4, this.map.width - 4),
        0.015 + i * 0.00002,
        rng.range(4, this.map.height - 4),
      );
      disc.receiveShadow = true;
      this.scene.add(disc);
    }

    const roadColor = 0x6b5b3f;
    const roadMat = new THREE.MeshStandardMaterial({ color: roadColor, roughness: 1 });
    const roads: Array<[number, number, number, number, number]> = [
      [100, 39, 20, 39, 4.4],
      [100, 39, 82, 18, 2.6],
      [100, 39, 82, 60, 2.6],
      [20, 39, 38, 18, 2.6],
      [20, 39, 38, 60, 2.6],
      [100, 39, 78, 30, 2.3],
      [100, 39, 78, 48, 2.3],
      [20, 39, 42, 30, 2.3],
      [20, 39, 42, 48, 2.3],
      [38, 18, 60, 10, 2.2],
      [38, 60, 60, 68, 2.2],
      [82, 18, 60, 10, 2.2],
      [82, 60, 60, 68, 2.2],
    ];
    for (const [ax, ay, bx, by, width] of roads) {
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      const geo = new THREE.PlaneGeometry(len, width);
      geo.rotateX(-Math.PI / 2);
      const road = new THREE.Mesh(geo, roadMat);
      road.position.set((ax + bx) / 2, 0.035, (ay + by) / 2);
      road.rotation.y = -Math.atan2(dy, dx);
      road.receiveShadow = true;
      this.scene.add(road);
    }

    // Трава.
    const grassGeo = new THREE.ConeGeometry(0.12, 0.5, 3);
    grassGeo.translate(0, 0.25, 0);
    const grass = new THREE.InstancedMesh(
      grassGeo,
      new THREE.MeshStandardMaterial({ color: 0x4f7138, roughness: 1, flatShading: true }),
      500,
    );
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const color = new THREE.Color();
    for (let i = 0; i < 500; i++) {
      const x = rng.range(3, this.map.width - 3);
      const y = rng.range(3, this.map.height - 3);
      quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, Math.PI * 2));
      scale.setScalar(rng.range(0.7, 1.5));
      matrix.compose(new THREE.Vector3(x, 0, y), quat, scale);
      grass.setMatrixAt(i, matrix);
      color.setHSL(0.25 + rng.range(-0.03, 0.03), 0.35, 0.26 + rng.range(-0.04, 0.05));
      grass.setColorAt(i, color);
    }
    grass.instanceMatrix.needsUpdate = true;
    if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
    this.scene.add(grass);

    return mesh;
  }

  private buildDecor(): void {
    const trees = this.map.trees;
    const trunkGeo = new THREE.CylinderGeometry(0.11, 0.17, 0.9, 5);
    trunkGeo.translate(0, 0.45, 0);
    const trunkMesh = new THREE.InstancedMesh(
      trunkGeo,
      new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 1, flatShading: true }),
      trees.length,
    );
    const leafGeo = new THREE.ConeGeometry(1, 1.7, 6);
    leafGeo.translate(0, 0.85, 0);
    const leafMesh = new THREE.InstancedMesh(
      leafGeo,
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true }),
      trees.length * 2,
    );
    const matrix = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const color = new THREE.Color();
    const leafColors = [0x2c4a2a, 0x355a31, 0x264026, 0x3f6336];

    trees.forEach((tree, index) => {
      quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (tree.v + 1) * 1.7);
      position.set(tree.x, 0, tree.y);
      scale.setScalar(tree.s);
      matrix.compose(position, quat, scale);
      trunkMesh.setMatrixAt(index, matrix);

      scale.setScalar(tree.s * 1.05);
      position.set(tree.x, 0.75 * tree.s, tree.y);
      matrix.compose(position, quat, scale);
      leafMesh.setMatrixAt(index * 2, matrix);
      color.setHex(leafColors[tree.v % leafColors.length]!);
      leafMesh.setColorAt(index * 2, color);

      scale.setScalar(tree.s * 0.7);
      position.set(tree.x, 1.55 * tree.s, tree.y);
      matrix.compose(position, quat, scale);
      leafMesh.setMatrixAt(index * 2 + 1, matrix);
      color.offsetHSL(0.01, 0.02, 0.03);
      leafMesh.setColorAt(index * 2 + 1, color);
    });
    trunkMesh.instanceMatrix.needsUpdate = true;
    leafMesh.instanceMatrix.needsUpdate = true;
    if (leafMesh.instanceColor) leafMesh.instanceColor.needsUpdate = true;
    trunkMesh.castShadow = true;
    leafMesh.castShadow = true;
    trunkMesh.receiveShadow = true;
    leafMesh.receiveShadow = true;
    this.scene.add(trunkMesh, leafMesh);

    const rocks = this.map.rocks;
    const rockGeo = new THREE.IcosahedronGeometry(0.9, 0);
    const rockMesh = new THREE.InstancedMesh(
      rockGeo,
      new THREE.MeshStandardMaterial({ color: 0x62666b, roughness: 1, flatShading: true }),
      rocks.length,
    );
    rocks.forEach((rock, index) => {
      quat.setFromEuler(new THREE.Euler(rock.v * 0.4, rock.v * 1.3, rock.v * 0.2));
      position.set(rock.x, 0.35 * rock.s, rock.y);
      scale.set(rock.s, rock.s * 0.75, rock.s);
      matrix.compose(position, quat, scale);
      rockMesh.setMatrixAt(index, matrix);
    });
    rockMesh.instanceMatrix.needsUpdate = true;
    rockMesh.castShadow = true;
    rockMesh.receiveShadow = true;
    this.scene.add(rockMesh);
  }

  private buildMountains(): void {
    const rng = new Rng(this.map.seed ^ 0x99aa);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x15232a,
      roughness: 1,
      flatShading: true,
    });
    for (let i = 0; i < 26; i++) {
      const angle = (i / 26) * Math.PI * 2 + rng.range(-0.06, 0.06);
      const radius = 112 + rng.range(-8, 18);
      const height = rng.range(24, 48);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(rng.range(18, 30), height, 5), mat);
      cone.position.set(
        this.map.width / 2 + Math.cos(angle) * radius,
        height / 2 - 2,
        this.map.height / 2 + Math.sin(angle) * radius,
      );
      cone.rotation.y = rng.range(0, 3);
      this.scene.add(cone);
    }
  }

  private buildBaseDecor(): void {
    for (const base of this.map.bases) {
      const colors = TEAM_COLORS[base.team]!;
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(base.radius * 0.55, 10),
        new THREE.MeshBasicMaterial({
          color: colors.dark,
          transparent: true,
          opacity: 0.28,
        }),
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(base.x, 0.05, base.y);
      this.scene.add(disc);

      for (let i = 0; i < 3; i++) {
        const angle = (i / 3) * Math.PI * 2 + 0.6;
        this.addFlag(
          base.x + Math.cos(angle) * (base.radius * 0.5),
          base.y + Math.sin(angle) * (base.radius * 0.5),
          colors.main,
          colors.accent,
        );
      }
    }
  }

  private addFlag(x: number, y: number, main: number, accent: number): void {
    const group = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.08, 3.4, 5),
      new THREE.MeshStandardMaterial({ color: 0x6b5b45, roughness: 1 }),
    );
    pole.position.y = 1.7;
    pole.castShadow = true;
    group.add(pole);
    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(1.55, 0.9),
      new THREE.MeshStandardMaterial({
        color: main,
        roughness: 0.9,
        side: THREE.DoubleSide,
        emissive: accent,
        emissiveIntensity: 0.08,
      }),
    );
    flag.position.set(0.8, 2.8, 0);
    group.add(flag);
    group.position.set(x, 0, y);
    group.rotation.y = -0.7;
    this.scene.add(group);
  }

  // ------------------------------------------------------------- построения

  private buildMinimapBase(): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = 224;
    canvas.height = 146;
    const ctx = canvas.getContext("2d")!;
    const sx = canvas.width / this.map.width;
    const sy = canvas.height / this.map.height;
    ctx.fillStyle = "#1a2a1e";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const tree of this.map.trees) {
      ctx.fillStyle = tree.v % 2 === 0 ? "#2f4a32" : "#35523a";
      ctx.fillRect(tree.x * sx, tree.y * sy, 1.2, 1.2);
    }
    for (const rock of this.map.rocks) {
      ctx.fillStyle = "#4b4f54";
      ctx.fillRect(rock.x * sx, rock.y * sy, 1.2, 1.2);
    }
    for (const node of this.map.nodes) {
      ctx.fillStyle = node.kind === "gold" ? "#e8bf58" : "#6a9b52";
      ctx.beginPath();
      ctx.arc(node.x * sx, node.y * sy, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const base of this.map.bases) {
      const color = TEAM_COLORS[base.team]!;
      ctx.strokeStyle = `#${color.main.toString(16).padStart(6, "0")}`;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(base.x * sx, base.y * sy, base.radius * sx, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    return canvas;
  }

  private nodeViews = new Map<number, THREE.Group>();

  // --------------------------------------------------------------- модели

  private material(color: number, emissive = 0x000000): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color,
      roughness: 0.92,
      metalness: 0.02,
      flatShading: true,
      emissive,
      emissiveIntensity: emissive ? 0.55 : 0,
    });
  }

  private box(
    parent: THREE.Group,
    w: number,
    h: number,
    d: number,
    color: number,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.material(color));
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private cone(
    parent: THREE.Group,
    radius: number,
    height: number,
    color: number,
    x: number,
    y: number,
    z: number,
    segments = 4,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.ConeGeometry(radius, height, segments), this.material(color));
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.rotation.y = Math.PI / 4;
    parent.add(mesh);
    return mesh;
  }

  private createUnitModel(type: UnitKind, team: Team): { group: THREE.Group; height: number } {
    const group = new THREE.Group();
    const colors = TEAM_COLORS[team]!;
    const skin = 0xc99872;
    let height = 1.5;
    if (type === "worker") {
      this.box(group, 0.5, 0.65, 0.38, colors.main, 0, 0.62, 0);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 7, 5), this.material(skin));
      head.position.y = 1.12;
      head.castShadow = true;
      group.add(head);
      const pack = this.box(group, 0.34, 0.36, 0.2, 0x6b5738, 0, 0.75, -0.28);
      pack.castShadow = true;
      this.box(group, 0.07, 0.08, 0.62, 0x8a7350, 0.33, 0.6, 0.12).rotation.x = 0.4;
      height = 1.5;
    } else if (type === "soldier") {
      this.box(group, 0.56, 0.62, 0.42, colors.main, 0, 0.72, 0);
      this.box(group, 0.18, 0.5, 0.3, colors.dark, -0.34, 0.6, 0);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 7, 5), this.material(skin));
      head.position.y = 1.2;
      head.castShadow = true;
      group.add(head);
      this.cone(group, 0.26, 0.28, 0xb8c0cc, 0, 1.35, 0, 6);
      const shield = this.box(group, 0.12, 0.62, 0.44, colors.light, -0.42, 0.76, 0.05);
      shield.rotation.z = 0.1;
      const sword = this.box(group, 0.06, 0.78, 0.1, 0xd9dde4, 0.42, 0.86, 0.1);
      sword.rotation.z = -0.35;
      height = 1.75;
    } else if (type === "archer") {
      this.box(group, 0.48, 0.6, 0.4, colors.main, 0, 0.7, 0);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 7, 5), this.material(skin));
      head.position.y = 1.14;
      group.add(head);
      this.cone(group, 0.32, 0.55, colors.dark, 0, 1.28, 0, 6);
      const bow = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.035, 5, 12, Math.PI * 1.3), this.material(0x9b7746));
      bow.position.set(0.36, 0.86, 0.18);
      bow.rotation.set(Math.PI / 2, 0, 0.4);
      group.add(bow);
      this.box(group, 0.2, 0.5, 0.12, colors.dark, 0, 0.55, -0.26);
      height = 1.7;
    } else if (type === "catapult") {
      this.box(group, 1.4, 0.26, 0.95, 0x6b4f31, 0, 0.42, 0);
      for (const dx of [-0.5, 0.5]) {
        for (const dz of [-0.4, 0.4]) {
          const wheel = new THREE.Mesh(
            new THREE.CylinderGeometry(0.26, 0.26, 0.14, 8),
            this.material(0x4b3722),
          );
          wheel.rotation.z = Math.PI / 2;
          wheel.position.set(dx, 0.3, dz);
          wheel.castShadow = true;
          group.add(wheel);
        }
      }
      const arm = this.box(group, 0.16, 1.25, 0.16, 0x8a6a42, -0.1, 1.05, 0);
      arm.rotation.z = -0.7;
      this.box(group, 0.5, 0.25, 0.4, 0x4a4f55, 0.42, 1.35, 0);
      this.box(group, 0.5, 0.5, 0.06, colors.main, 0, 0.75, 0.55);
      height = 1.9;
    } else {
      // Герой.
      this.box(group, 0.7, 0.85, 0.5, colors.main, 0, 0.9, 0);
      const cape = this.box(group, 0.72, 1.05, 0.08, colors.dark, 0, 0.82, -0.33);
      cape.rotation.x = 0.12;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), this.material(skin));
      head.position.y = 1.48;
      head.castShadow = true;
      group.add(head);
      this.cone(group, 0.3, 0.38, 0xd8b25c, 0, 1.65, 0, 6);
      const sword = this.box(group, 0.09, 1.15, 0.13, 0xe8ecf2, 0.48, 1.1, 0.12);
      sword.rotation.z = -0.24;
      this.box(group, 0.16, 0.16, 0.55, 0xd8b25c, 0.42, 0.62, 0.12);
      this.box(group, 0.26, 0.14, 0.26, 0xd8b25c, -0.34, 1.3, 0);
      this.box(group, 0.26, 0.14, 0.26, 0xd8b25c, 0.34, 1.3, 0);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.62, 0.78, 24),
        new THREE.MeshBasicMaterial({ color: colors.accent, transparent: true, opacity: 0.45, side: THREE.DoubleSide }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.04;
      group.add(ring);
      height = 2.15;
    }
    group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true;
      }
    });
    return { group, height };
  }

  private createBuildingModel(
    type: BuildingKind,
    team: Team,
  ): { group: THREE.Group; height: number; spin?: THREE.Object3D } {
    const group = new THREE.Group();
    const colors = TEAM_COLORS[team]!;
    const stone = 0x6d6a60;
    const darkStone = 0x4d4b45;
    let height = 3;
    let spin: THREE.Object3D | undefined;

    if (type === "hall") {
      this.box(group, 4.6, 1.1, 3.8, darkStone, 0, 0.55, 0);
      this.box(group, 3.6, 1.9, 3, stone, 0, 1.95, 0);
      this.cone(group, 2.9, 1.7, colors.dark, 0, 3.7, 0, 4);
      this.box(group, 0.3, 3.2, 0.3, 0x5a4a34, -1.5, 1.6, 1.55);
      this.box(group, 0.3, 3.2, 0.3, 0x5a4a34, 1.5, 1.6, 1.55);
      const flag = this.box(group, 1.7, 0.9, 0.06, colors.main, -0.85, 3.1, 1.55);
      flag.material = this.material(colors.main, colors.accent);
      const door = this.box(group, 0.8, 1.2, 0.1, 0x2a2119, 0, 0.75, 1.55);
      door.castShadow = false;
      this.box(group, 0.5, 0.5, 0.5, colors.main, 0, 3.1, 0);
      height = 5.1;
    } else if (type === "barracks") {
      this.box(group, 3.2, 0.6, 2.6, darkStone, 0, 0.3, 0);
      this.box(group, 2.9, 1.35, 2.3, 0x7a6b52, 0, 1.25, 0);
      this.cone(group, 2.3, 1.2, colors.dark, 0, 2.5, 0, 4);
      this.box(group, 0.16, 1.2, 0.16, 0x5a4a34, 1.1, 1.5, 1.15);
      this.box(group, 0.85, 0.5, 0.06, colors.main, 0.62, 1.75, 1.2);
      for (const dx of [-0.8, 0.8]) {
        this.box(group, 0.3, 0.3, 0.12, 0x2a2119, dx, 0.9, 1.17);
      }
      height = 3.6;
    } else if (type === "workshop") {
      this.box(group, 2.6, 0.5, 2.2, darkStone, 0, 0.25, 0);
      this.box(group, 2.2, 1.35, 1.9, 0x6f6455, 0, 1.15, 0);
      this.cone(group, 1.9, 0.9, colors.dark, 0, 2.2, 0, 4);
      const chimney = this.box(group, 0.45, 1.5, 0.45, darkStone, 0.75, 2.4, -0.4);
      chimney.rotation.z = 0.04;
      this.box(group, 0.7, 0.5, 0.7, 0x3a3a3a, 0.75, 3.15, -0.4);
      const gear = new THREE.Mesh(
        new THREE.TorusGeometry(0.38, 0.12, 6, 10),
        this.material(0x9a8255),
      );
      gear.position.set(-0.65, 1.6, 0.95);
      group.add(gear);
      spin = gear;
      this.box(group, 0.5, 0.3, 0.4, 0x555a60, 0.4, 0.8, 1.0);
      height = 3.5;
    } else if (type === "tower") {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.25, 3.4, 7), this.material(stone));
      body.position.y = 1.7;
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);
      for (let i = 0; i < 5; i++) {
        const angle = (i / 5) * Math.PI * 2;
        this.box(
          group,
          0.38,
          0.42,
          0.38,
          darkStone,
          Math.cos(angle) * 1.0,
          3.6,
          Math.sin(angle) * 1.0,
        );
      }
      this.cone(group, 1.45, 1.2, colors.dark, 0, 4.3, 0, 6);
      this.box(group, 0.9, 0.5, 0.6, colors.main, 0, 3.1, 1.05);
      height = 5;
    } else if (type === "house") {
      this.box(group, 1.5, 0.9, 1.25, 0x7c694e, 0, 0.45, 0);
      this.cone(group, 1.25, 0.9, colors.dark, 0, 1.35, 0, 4);
      this.box(group, 0.3, 0.5, 0.08, 0x2a2119, 0, 0.4, 0.64);
      this.box(group, 0.22, 0.7, 0.22, darkStone, 0.42, 1.75, -0.2);
      height = 2.2;
    } else if (type === "outpost") {
      this.box(group, 2.2, 0.35, 2, 0x6a5a43, 0, 0.18, 0);
      this.cone(group, 1.5, 1.5, colors.dark, 0, 1.1, 0, 5);
      this.box(group, 0.14, 2.8, 0.14, 0x5a4a34, 0.7, 1.4, 0.7);
      this.box(group, 1.15, 0.6, 0.05, colors.main, 1.22, 2.45, 0.7);
      this.box(group, 0.5, 0.4, 0.5, 0x3a3a3a, -0.6, 0.7, 0.5);
      height = 3.4;
    } else if (type === "wall") {
      this.box(group, 2, 1.25, 0.9, stone, 0, 0.62, 0);
      this.box(group, 2.05, 0.18, 0.95, darkStone, 0, 1.3, 0);
      for (const dx of [-0.65, 0, 0.65]) {
        this.box(group, 0.32, 0.3, 0.32, darkStone, dx, 1.52, 0);
      }
      height = 1.9;
    } else {
      // Трофей.
      this.box(group, 1.8, 0.45, 1.8, darkStone, 0, 0.22, 0);
      this.box(group, 1.2, 0.7, 1.2, stone, 0, 0.78, 0);
      const gem = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.48, 0),
        this.material(0xf2c14e, 0xd8a020),
      );
      gem.position.y = 1.9;
      gem.castShadow = true;
      group.add(gem);
      spin = gem;
      this.box(group, 0.14, 1.5, 0.14, 0x6b5b45, 0.7, 1.4, 0.35);
      this.box(group, 0.8, 0.45, 0.05, 0x8a6a42, 1.03, 1.95, 0.35);
      height = 2.6;
    }

    group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return { group, height, spin };
  }

  private createNodeView(nodeId: number, kind: "gold" | "wood", x: number, y: number): THREE.Group {
    const group = new THREE.Group();
    group.position.set(x, 0, y);
    if (kind === "gold") {
      for (let i = 0; i < 3; i++) {
        const rock = new THREE.Mesh(
          new THREE.IcosahedronGeometry(1.1 + i * 0.15, 0),
          this.material(0x5d5b55),
        );
        rock.position.set(Math.cos(i * 2.1) * 1.1, 0.5, Math.sin(i * 2.1) * 1.1);
        rock.rotation.set(i, i * 1.3, 0);
        rock.castShadow = true;
        group.add(rock);
      }
      for (let i = 0; i < 6; i++) {
        const crystal = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.28 + (i % 3) * 0.08, 0),
          this.material(0xf2c14e, 0xd8a020),
        );
        crystal.position.set(Math.cos(i * 1.7) * 1.2, 1 + (i % 2) * 0.4, Math.sin(i * 1.7) * 1.2);
        crystal.rotation.y = i;
        group.add(crystal);
      }
    } else {
      for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2;
        const trunk = new THREE.Mesh(
          new THREE.CylinderGeometry(0.12, 0.18, 1.1, 5),
          this.material(0x4a3524),
        );
        trunk.position.set(Math.cos(angle) * 1.5, 0.55, Math.sin(angle) * 1.5);
        trunk.castShadow = true;
        group.add(trunk);
        const crown = new THREE.Mesh(
          new THREE.ConeGeometry(0.9, 2, 6),
          this.material(i % 2 === 0 ? 0x2c4a2a : 0x355a31),
        );
        crown.position.set(Math.cos(angle) * 1.5, 2, Math.sin(angle) * 1.5);
        crown.castShadow = true;
        group.add(crown);
      }
    }
    group.userData.nodeId = nodeId;
    group.userData.kind = kind;
    this.nodeViews.set(nodeId, group);
    this.scene.add(group);
    return group;
  }

  // ------------------------------------------------------------- сущности

  private upsertEntity(snap: EntitySnapshot): void {
    let view = this.views.get(snap.id);
    if (!view) {
      const built = snap.k === "u"
        ? this.createUnitModel(snap.t as UnitKind, snap.team)
        : this.createBuildingModel(snap.t as BuildingKind, snap.team);
      const group = new THREE.Group();
      group.add(built.group);
      group.position.set(snap.x, 0, snap.y);
      group.userData.eid = snap.id;
      group.userData.team = snap.team;
      const colors = TEAM_COLORS[snap.team]!;
      const isHero = snap.t === "hero";
      const barWidth = snap.k === "b" ? Math.max(2.4, built.height * 0.7) : isHero ? 1.7 : 1.1;
      const bar = this.createBar(barWidth, colors, built.height + 0.55);
      group.add(bar.group);
      const ringRadius = snap.k === "b" ? Math.max(1.6, built.height * 0.55) : snap.t === "hero" ? 0.95 : 0.62;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(ringRadius, ringRadius + 0.16, 26),
        new THREE.MeshBasicMaterial({
          color: 0xffd77a,
          transparent: true,
          opacity: 0.9,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.06;
      ring.visible = false;
      group.add(ring);
      this.scene.add(group);
      view = {
        group,
        model: built.group,
        eid: snap.id,
        team: snap.team,
        kind: snap.k,
        type: snap.t,
        height: built.height,
        bar,
        ring,
        hp: snap.hp,
        maxHp: snap.mhp,
        targetX: snap.x,
        targetY: snap.y,
        x: snap.x,
        y: snap.y,
        done: snap.done,
        progress: snap.pr,
        level: snap.level,
        spin: snap.k === "b" ? (built as { spin?: THREE.Object3D }).spin : undefined,
        bobPhase: (snap.id * 1.7) % 10,
        selected: false,
        removeIn: null,
      };
      this.views.set(snap.id, view);
    }
    view.targetX = snap.x;
    view.targetY = snap.y;
    view.hp = snap.hp;
    view.maxHp = snap.mhp;
    view.done = snap.done;
    view.progress = snap.pr;
    view.level = snap.level;
    view.type = snap.t;

    if (view.bar) {
      const ratio = Math.max(0, Math.min(1, snap.hp / Math.max(1, snap.mhp)));
      view.bar.fill.scale.x = Math.max(0.001, ratio);
      const color = ratio > 0.55 ? 0x6ee07a : ratio > 0.25 ? 0xf2c14e : 0xe8574a;
      (view.bar.fill.material as THREE.MeshBasicMaterial).color.setHex(color);
      view.bar.group.visible = snap.hp < snap.mhp || view.selected || snap.k === "b";
    }
    if (view.model && snap.k === "b") {
      view.model.scale.y = snap.done ? 1 : Math.max(0.25, 0.25 + 0.75 * snap.pr);
    }
  }

  private createBar(
    width: number,
    colors: { main: number },
    height: number,
  ): { group: THREE.Group; fill: THREE.Mesh } {
    const group = new THREE.Group();
    group.position.y = height;
    const bg = new THREE.Mesh(
      new THREE.PlaneGeometry(width + 0.08, 0.16),
      new THREE.MeshBasicMaterial({ color: 0x0a0d0f, transparent: true, opacity: 0.86, depthWrite: false }),
    );
    group.add(bg);
    const fillGeo = new THREE.PlaneGeometry(width, 0.1);
    fillGeo.translate(width / 2, 0, 0);
    const fill = new THREE.Mesh(
      fillGeo,
      new THREE.MeshBasicMaterial({ color: 0x6ee07a, depthWrite: false }),
    );
    fill.position.set(-width / 2, 0.005, 0.005);
    group.add(fill);
    return { group, fill };
  }

  applySnapshot(snap: Snapshot, ownTeam: Team): void {
    this.snapshot = snap;
    this.handleEvents(snap.events);
    for (const entity of snap.entities) {
      this.upsertEntity(entity);
    }
    const liveIds = new Set(snap.entities.map((e) => e.id));
    for (const [id, view] of this.views) {
      if (!liveIds.has(id) && view.removeIn === null) {
        view.removeIn = 0.55;
        this.spawnDeath(view.x, view.y, view.team);
      }
    }
    for (const node of snap.nodes) {
      let group = this.nodeViews.get(node.id);
      if (!group) group = this.createNodeView(node.id, node.kind, node.x, node.y);
      group.visible = node.amount > 0;
      const ratio = node.amount / Math.max(1, node.max);
      group.scale.setScalar(0.55 + 0.45 * ratio);
    }
    if (snap.fog) {
      this.updateFog(snap.fog, snap.fogW, snap.fogH);
    }
  }

  private updateFog(base64: string, w: number, h: number): void {
    const bytes = decodeBase64(base64);
    const tmp = this.fogTmp;
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext("2d")!;
    const image = tctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const value = bytes[i] ?? 0;
      const alpha = value === 2 ? 0 : value === 1 ? 120 : 240;
      image.data[i * 4] = 5;
      image.data[i * 4 + 1] = 10;
      image.data[i * 4 + 2] = 14;
      image.data[i * 4 + 3] = alpha;
    }
    tctx.putImageData(image, 0, 0);
    const canvas = this.fogCanvas;
    canvas.width = Math.max(2, w * 4);
    canvas.height = Math.max(2, h * 4);
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.filter = "blur(6px)";
    ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
    ctx.filter = "none";
    this.fogTexture.dispose();
    this.fogTexture = new THREE.CanvasTexture(canvas);
    this.fogTexture.minFilter = THREE.LinearFilter;
    this.fogTexture.magFilter = THREE.LinearFilter;
    (this.fogMesh.material as THREE.MeshBasicMaterial).map = this.fogTexture;
    (this.fogMesh.material as THREE.MeshBasicMaterial).needsUpdate = true;
  }

  private handleEvents(events: SimEvent[]): void {
    for (const event of events) {
      if (event.type === "attack") {
        if (event.ranged) {
          this.spawnProjectile(event.fromX, event.fromY, event.toX, event.toY, event.team);
        } else {
          this.spawnSpark(event.toX, event.toY, 0xffd77a, 3);
        }
      } else if (event.type === "hit") {
        this.spawnSpark(event.x, event.y, 0xffe6a8, 2);
      } else if (event.type === "death") {
        this.spawnDeath(event.x, event.y, event.team);
      } else if (event.type === "levelup") {
        this.spawnRing(event.x, event.y, event.team === 0 ? 0x7fe3ff : 0xffc861);
      }
    }
  }

  private spawnProjectile(fromX: number, fromY: number, toX: number, toY: number, team: Team): void {
    const color = team === 0 ? 0xbfe4ff : team === 1 ? 0xffc08a : 0xd8d8d8;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 6, 5),
      new THREE.MeshBasicMaterial({ color }),
    );
    mesh.position.set(fromX, 1.3, fromY);
    this.scene.add(mesh);
    this.effectList.push({
      object: mesh,
      life: 0,
      max: 0.32,
      update: (t, object) => {
        object.position.x = fromX + (toX - fromX) * t;
        object.position.z = fromY + (toY - fromY) * t;
        object.position.y = 1.3 + Math.sin(t * Math.PI) * 1.1;
        object.scale.setScalar(1 - t * 0.4);
      },
    });
  }

  private spawnSpark(x: number, y: number, color: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 4, 3),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 }),
      );
      mesh.position.set(x, 0.9, y);
      this.scene.add(mesh);
      const angle = Math.random() * Math.PI * 2;
      const distance = 0.4 + Math.random() * 0.6;
      this.effectList.push({
        object: mesh,
        life: 0,
        max: 0.35,
        update: (t, object) => {
          object.position.x = x + Math.cos(angle) * distance * t;
          object.position.z = y + Math.sin(angle) * distance * t;
          object.position.y = 0.9 + t * 0.9;
          (object as THREE.Mesh).scale.setScalar(1 - t);
          ((object as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 1 - t;
        },
      });
    }
  }

  private spawnDeath(x: number, y: number, team: Team): void {
    const color = TEAM_COLORS[team]?.main ?? 0x8a8f98;
    for (let i = 0; i < 6; i++) {
      const mesh = new THREE.Mesh(
        new THREE.TetrahedronGeometry(0.22, 0),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8 }),
      );
      mesh.position.set(x, 0.8, y);
      this.scene.add(mesh);
      const angle = Math.random() * Math.PI * 2;
      const dist = 0.5 + Math.random() * 1.1;
      this.effectList.push({
        object: mesh,
        life: 0,
        max: 0.7,
        update: (t, object) => {
          object.position.x = x + Math.cos(angle) * dist * t;
          object.position.z = y + Math.sin(angle) * dist * t;
          object.position.y = 0.8 + t * 1.4;
          object.rotation.x += 0.15;
          ((object as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - t);
        },
      });
    }
  }

  private spawnRing(x: number, y: number, color: number): void {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 1, 30),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.15, y);
    this.scene.add(mesh);
    this.effectList.push({
      object: mesh,
      life: 0,
      max: 1,
      update: (t, object) => {
        object.scale.setScalar(1 + t * 3);
        ((object as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t);
      },
    });
  }

  update(dt: number, elapsed: number): void {
    // Сущности.
    for (const [id, view] of this.views) {
      if (view.removeIn !== null) {
        view.removeIn -= dt;
        view.group.scale.setScalar(Math.max(0.01, view.removeIn / 0.55));
        if (view.removeIn <= 0) {
          this.scene.remove(view.group);
          this.views.delete(id);
        }
        continue;
      }
      const lerp = Math.min(1, dt * 10);
      view.x += (view.targetX - view.x) * lerp;
      view.y += (view.targetY - view.y) * lerp;
      view.group.position.x = view.x;
      view.group.position.z = view.y;
      if (view.kind === "u") {
        const bob = view.type === "hero" ? 0.04 : 0.025;
        view.model.position.y = Math.sin(elapsed * 3.4 + view.bobPhase) * bob;
        const dx = view.targetX - view.x;
        const dy = view.targetY - view.y;
        if (Math.abs(dx) + Math.abs(dy) > 0.01) {
          view.group.rotation.y = Math.PI / 2 - Math.atan2(dy, dx);
        }
      }
      if (view.spin) view.spin.rotation.y += dt * 1.4;
      if (view.bar) view.bar.group.quaternion.copy(this.camera.quaternion);
      if (view.ring) {
        view.ring.visible = this.selection.has(view.eid);
        if (view.ring.visible) {
          const pulse = 1 + Math.sin(elapsed * 5) * 0.05;
          view.ring.scale.setScalar(pulse);
        }
      }
    }

    // Эффекты.
    for (let i = this.effectList.length - 1; i >= 0; i--) {
      const effect = this.effectList[i]!;
      effect.life += dt;
      const t = Math.min(1, effect.life / effect.max);
      effect.update(t, effect.object);
      if (t >= 1) {
        this.scene.remove(effect.object);
        this.effectList.splice(i, 1);
      }
    }

    // Камера.
    this.target.lerp(this.cameraTargetGoal, Math.min(1, dt * 8));
    const height = Math.sin((52 * Math.PI) / 180) * this.zoom;
    const distance = Math.cos((52 * Math.PI) / 180) * this.zoom;
    this.camera.position.set(this.target.x, height, this.target.z + distance);
    this.camera.lookAt(this.target.x, 0, this.target.z);
    this.camera.updateMatrixWorld();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  // ------------------------------------------------------------- ввод/камера

  screenToGround(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const point = new THREE.Vector3();
    const hit = this.raycaster.ray.intersectPlane(this.groundPlane, point);
    if (!hit) return null;
    return { x: point.x, y: point.z };
  }

  /** Экранные координаты точки мира — используется отладкой и тестами. */
  worldToScreen(x: number, y: number, height = 1): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const point = new THREE.Vector3(x, height, y).project(this.camera);
    return {
      x: rect.left + ((point.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - point.y) / 2) * rect.height,
    };
  }

  entityAt(clientX: number, clientY: number): { id: number; team: Team } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const objects: THREE.Object3D[] = [];
    for (const view of this.views.values()) objects.push(view.group);
    const intersections = this.raycaster.intersectObjects(objects, true);
    for (const hit of intersections) {
      let node: THREE.Object3D | null = hit.object;
      while (node && node.userData.eid === undefined) node = node.parent;
      if (node) return { id: node.userData.eid as number, team: node.userData.team as Team };
    }
    return null;
  }

  nodeAt(clientX: number, clientY: number): { id: number; kind: NodeKind } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const objects: THREE.Object3D[] = [];
    for (const group of this.nodeViews.values()) {
      if (group.visible) objects.push(group);
    }
    if (!objects.length) return null;
    const intersections = this.raycaster.intersectObjects(objects, true);
    for (const hit of intersections) {
      let node: THREE.Object3D | null = hit.object;
      while (node && node.userData.nodeId === undefined) node = node.parent;
      if (node) {
        return {
          id: node.userData.nodeId as number,
          kind: node.userData.kind as NodeKind,
        };
      }
    }
    return null;
  }

  entitiesInRect(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    team: Team,
  ): number[] {
    const rect = this.canvas.getBoundingClientRect();
    const left = Math.min(x1, x2) - rect.left;
    const right = Math.max(x1, x2) - rect.left;
    const top = Math.min(y1, y2) - rect.top;
    const bottom = Math.max(y1, y2) - rect.top;
    const point = new THREE.Vector3();
    const result: number[] = [];
    for (const view of this.views.values()) {
      if (view.team !== team || view.kind !== "u" || view.removeIn !== null) continue;
      point.set(view.x, 1, view.y).project(this.camera);
      const sx = ((point.x + 1) / 2) * rect.width;
      const sy = ((1 - point.y) / 2) * rect.height;
      if (sx >= left && sx <= right && sy >= top && sy <= bottom) result.push(view.eid);
    }
    return result;
  }

  setSelection(ids: number[]): void {
    this.selection.clear();
    for (const id of ids) this.selection.add(id);
    for (const [id, view] of this.views) {
      if (view.ring) view.ring.visible = this.selection.has(id);
      if (view.bar) view.bar.group.visible = view.hp < view.maxHp || this.selection.has(id) || view.kind === "b";
    }
  }

  focusOn(x: number, y: number, instant = false): void {
    this.cameraTargetGoal.set(
      Math.max(10, Math.min(this.map.width - 10, x)),
      0,
      Math.max(10, Math.min(this.map.height - 10, y)),
    );
    if (instant) this.target.copy(this.cameraTargetGoal);
  }

  pan(dx: number, dy: number): void {
    this.cameraTargetGoal.x = Math.max(8, Math.min(this.map.width - 8, this.cameraTargetGoal.x + dx));
    this.cameraTargetGoal.z = Math.max(8, Math.min(this.map.height - 8, this.cameraTargetGoal.z + dy));
  }

  zoomBy(delta: number): void {
    this.zoom = Math.max(26, Math.min(82, this.zoom + delta));
  }

  createGhost(kind: BuildingKind): THREE.Group {
    const built = this.createBuildingModel(kind, 0);
    const group = new THREE.Group();
    built.group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.material = new THREE.MeshBasicMaterial({
          color: 0x7fe3ff,
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
        });
        mesh.castShadow = false;
      }
    });
    group.add(built.group);
    group.visible = false;
    this.scene.add(group);
    return group;
  }

  setGhostPosition(ghost: THREE.Group, x: number, y: number, valid: boolean): void {
    ghost.visible = true;
    ghost.position.set(x, 0, y);
    ghost.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const material = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
        if (material && "color" in material) {
          material.color.setHex(valid ? 0x7fe3ff : 0xff6b5a);
        }
      }
    });
  }

  hideGhost(ghost: THREE.Group): void {
    ghost.visible = false;
  }

  removeGhost(ghost: THREE.Group): void {
    this.scene.remove(ghost);
  }

  // ---------------------------------------------------------------- миникарта

  drawMinimap(
    canvas: HTMLCanvasElement,
    snap: Snapshot,
    ownTeam: Team,
    selection: number[],
  ): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const sx = canvas.width / this.map.width;
    const sy = canvas.height / this.map.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(this.minimapBase, 0, 0, canvas.width, canvas.height);

    for (const node of snap.nodes) {
      if (node.amount <= 0) continue;
      ctx.fillStyle = node.kind === "gold" ? "#f0c95f" : "#77a85b";
      ctx.beginPath();
      ctx.arc(node.x * sx, node.y * sy, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }

    if (snap.fog) {
      const bytes = decodeBase64(snap.fog);
      const cw = canvas.width / snap.fogW;
      const ch = canvas.height / snap.fogH;
      for (let y = 0; y < snap.fogH; y++) {
        for (let x = 0; x < snap.fogW; x++) {
          const value = bytes[y * snap.fogW + x] ?? 0;
          if (value === 2) continue;
          ctx.fillStyle = value === 1 ? "rgba(4,8,10,0.42)" : "rgba(4,8,10,0.88)";
          ctx.fillRect(x * cw, y * ch, cw + 0.5, ch + 0.5);
        }
      }
    }

    for (const entity of snap.entities) {
      const color = entity.team === ownTeam
        ? entity.team === 0 ? "#7fb4ff" : "#ff9c7f"
        : entity.team === 2 ? "#c9ccd3" : "#ff5f4d";
      ctx.fillStyle = color;
      if (entity.k === "b") {
        ctx.fillRect(entity.x * sx - 2.5, entity.y * sy - 2.5, 5, 5);
      } else {
        ctx.beginPath();
        ctx.arc(entity.x * sx, entity.y * sy, 1.7, 0, Math.PI * 2);
        ctx.fill();
      }
      if (selection.includes(entity.id)) {
        ctx.strokeStyle = "#ffe08a";
        ctx.lineWidth = 1;
        ctx.strokeRect(entity.x * sx - 3, entity.y * sy - 3, 6, 6);
      }
    }

    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1;
    const viewW = this.zoom * 2.2 * sx;
    const viewH = this.zoom * 1.35 * sy;
    ctx.strokeRect(
      this.target.x * sx - viewW / 2,
      this.target.z * sy - viewH / 2,
      viewW,
      viewH,
    );
  }

  minimapToWorld(canvas: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * this.map.width;
    const y = ((clientY - rect.top) / rect.height) * this.map.height;
    return {
      x: Math.max(2, Math.min(this.map.width - 2, x)),
      y: Math.max(2, Math.min(this.map.height - 2, y)),
    };
  }

  get currentSnapshot(): Snapshot | null {
    return this.snapshot;
  }
}
