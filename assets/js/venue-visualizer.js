// Venue Visualizer — loads a .glb venue model into a Three.js scene with
// OrbitControls (drag to rotate, right-drag/two-finger to pan, scroll/pinch
// to zoom). Shared between the authenticated AMBRA app (palante.html, Stage
// tab) and public case-study pages (e.g. /tbf2026/) — pass the ids for
// whichever page's markup you're wiring up, since the two pages use the same
// element ids but at different times (lazy, behind a tab click, vs. right
// away on page load).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export function initVenueVisualizer(options = {}){
  const {
    modelUrl = '/assets/palante.glb',
    wrapId = 'stage3d-canvas-wrap',
    loaderId = 'stage3d-loader',
    barfillId = 'stage3d-barfill',
    emptyId = 'stage3d-empty',
    resetBtnId = 'btn-3d-reset',
    fullscreenBtnId = 'btn-3d-fullscreen',
    projectTitleId = 'stage3d-project-title',
    projectTitle = null,
    lazy = false,
    triggerEl = null,
    onModelLoaded = null,
  } = options;

  const wrap = document.getElementById(wrapId);
  if(!wrap) return null;
  const loaderEl = document.getElementById(loaderId);
  const barfill = document.getElementById(barfillId);
  const emptyEl = document.getElementById(emptyId);

  const projectTitleEl = document.getElementById(projectTitleId);
  if(projectTitleEl && projectTitle) projectTitleEl.textContent = projectTitle;

  let renderer, scene, camera, controls, currentModel, grid;
  let homePos = null, homeTarget = null;
  let initialized = false;

  // Renders only when something actually changes (camera moved, model loaded,
  // window resized) instead of an unconditional render loop — a permanent
  // setAnimationLoop burns GPU time even while the camera sits still or the
  // canvas is scrolled out of view.
  let renderRequested = false;
  function renderFrame(){
    renderRequested = false;
    controls.update();
    renderer.render(scene, camera);
  }
  function requestRender(){
    if(renderRequested) return;
    renderRequested = true;
    requestAnimationFrame(renderFrame);
  }

  function initScene(){
    if(initialized) return;
    initialized = true;
    const w = wrap.clientWidth || 800, h = wrap.clientHeight || 520;

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(w, h);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    wrap.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x161f1a);
    scene.fog = new THREE.Fog(0x161f1a, 40, 120);

    camera = new THREE.PerspectiveCamera(50, w / h, 0.05, 500);
    camera.position.set(4, 3, 6);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    const key = new THREE.DirectionalLight(0xfff1dc, 1.6);
    key.position.set(6, 10, 6);
    scene.add(key);
    const amber = new THREE.PointLight(0xd98a3d, 12, 40);
    amber.position.set(-5, 4, -3);
    scene.add(amber);
    const violet = new THREE.PointLight(0x8c6fb5, 10, 40);
    violet.position.set(5, 3, -5);
    scene.add(violet);
    scene.add(new THREE.AmbientLight(0xffffff, 0.15));

    grid = new THREE.GridHelper(60, 60, 0x3a4a3f, 0x241c16);
    grid.material.transparent = true;
    grid.material.opacity = 0.4;
    scene.add(grid);

    window.addEventListener('resize', () => {
      if(!wrap.clientWidth) return;
      camera.aspect = wrap.clientWidth / wrap.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(wrap.clientWidth, wrap.clientHeight);
      requestRender();
    });

    controls.addEventListener('change', requestRender);
    requestRender();
  }

  function frameModel(object){
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const dist = maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360)) * 1.4;

    controls.target.copy(center);
    camera.position.set(center.x + dist * 0.7, center.y + dist * 0.45, center.z + dist * 0.7);
    camera.near = maxDim / 100;
    camera.far = maxDim * 20;
    camera.updateProjectionMatrix();
    controls.minDistance = maxDim * 0.05;
    controls.maxDistance = maxDim * 6;
    scene.fog.near = maxDim * 3;
    scene.fog.far = maxDim * 12;
    grid.position.y = box.min.y;
    controls.update();
    requestRender();

    homePos = camera.position.clone();
    homeTarget = controls.target.clone();
  }

  const gltfLoader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/libs/draco/');
  gltfLoader.setDRACOLoader(draco);

  function addModel(gltf){
    if(currentModel) scene.remove(currentModel);
    currentModel = gltf.scene;
    scene.add(currentModel);
    frameModel(currentModel);
    if(loaderEl) loaderEl.style.display = 'none';
    if(emptyEl) emptyEl.style.display = 'none';
    renderer.domElement.style.display = 'block';
    if(onModelLoaded) onModelLoaded();
  }

  function loadFromURL(url, isInitialCheck){
    initScene();
    if(!isInitialCheck && loaderEl){ loaderEl.style.display = 'flex'; if(emptyEl) emptyEl.style.display = 'none'; }
    gltfLoader.load(
      url,
      (gltf) => addModel(gltf),
      (xhr) => { if(xhr.total && barfill) barfill.style.width = `${(xhr.loaded / xhr.total) * 100}%`; },
      () => {
        if(loaderEl) loaderEl.style.display = 'none';
        if(!currentModel){
          if(emptyEl) emptyEl.style.display = 'block';
          renderer.domElement.style.display = 'none';
        }
      }
    );
  }

  document.getElementById(resetBtnId)?.addEventListener('click', () => {
    if(!homePos) return;
    camera.position.copy(homePos);
    controls.target.copy(homeTarget);
    controls.update();
    requestRender();
  });
  document.getElementById(fullscreenBtnId)?.addEventListener('click', () => {
    document.fullscreenElement ? document.exitFullscreen() : wrap.requestFullscreen();
  });

  function start(){
    if(currentModel) return;
    initScene();
    loadFromURL(modelUrl, true);
  }

  if(lazy && triggerEl){
    triggerEl.addEventListener('click', start);
    if(triggerEl.classList.contains('active')) start();
  } else if(!lazy){
    start();
  }

  return { start };
}
