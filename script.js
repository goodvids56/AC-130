window.onload = function() {

    // --- Audio System ---
    // Plays real recorded sound effects from assets/sounds/ via the Web Audio API.
    // The playNoise(duration, type) signature is kept so existing call sites are
    // unchanged: `type` selects the sample, `duration` shapes rapid-fire/big booms.
    const AudioSys = {
        ctx: null,
        masterGain: null,
        buffers: {},          // decoded AudioBuffers keyed by type
        files: {
            '25':       'assets/sounds/gatling_25mm.mp3',    // 25mm Gatling (rapid)
            '40':       'assets/sounds/bofors_40mm.ogg',     // 40mm Bofors cannon
            '105':      'assets/sounds/howitzer_105mm.ogg',  // 105mm Howitzer
            'exp':      'assets/sounds/explosion.ogg',       // generic explosion / nuke
            'rifle':    'assets/sounds/infantry_rifle.wav',  // friendly infantry rifle
            'collapse': 'assets/sounds/building_collapse.ogg',// building falling apart
            'heli':     'assets/sounds/heli_rotor.mp3'        // looping helicopter rotor
        },
        // Per-type playback volume, a cap to stop rapid-fire shots piling up, and
        // an optional minInterval (seconds) to throttle mass-triggered one-shots.
        config: {
            '25':       { vol: 0.35, maxDur: 0.18 },
            '40':       { vol: 0.70, maxDur: 0.35 },
            '105':      { vol: 1.00, maxDur: null },
            'exp':      { vol: 0.90, maxDur: null },
            'rifle':    { vol: 0.45, maxDur: 0.30 },
            'collapse': { vol: 0.80, maxDur: null, minInterval: 0.12 }
        },
        lastPlay: {},         // type -> ctx time of last play (for minInterval)
        loops: {},            // type -> { src, gain, count, vol } for looping sounds
        init: function() {
            if (!this.ctx) {
                this.ctx = new (window.AudioContext || window.webkitAudioContext)();
                this.masterGain = this.ctx.createGain();
                this.masterGain.gain.value = 0.9;
                this.masterGain.connect(this.ctx.destination);
                this.loadAll();
            }
            if (this.ctx.state === 'suspended') this.ctx.resume();
        },
        loadAll: function() {
            Object.keys(this.files).forEach(type => {
                fetch(this.files[type])
                    .then(res => res.arrayBuffer())
                    .then(data => this.ctx.decodeAudioData(data))
                    .then(decoded => {
                        this.buffers[type] = decoded;
                        this._ensureLoop(type); // start any loop that was requested before load
                    })
                    .catch(err => console.warn('AudioSys: failed to load', type, err));
            });
        },
        playNoise: function(duration, type) {
            if (!this.ctx) return;
            const buffer = this.buffers[type];
            if (!buffer) return; // sample not decoded yet; stay silent

            const cfg = this.config[type] || { vol: 1.0, maxDur: null };
            const now = this.ctx.currentTime;

            // Throttle one-shots that can be triggered en masse (e.g. many
            // buildings collapsing at once) so they don't stack into noise.
            if (cfg.minInterval) {
                if (this.lastPlay[type] && now - this.lastPlay[type] < cfg.minInterval) return;
                this.lastPlay[type] = now;
            }

            const src = this.ctx.createBufferSource();
            src.buffer = buffer;

            const gain = this.ctx.createGain();
            let vol = cfg.vol;

            // Big explosions (e.g. the atom bomb passes duration ~10) play deeper
            // and at full volume for a heavier, longer boom.
            if (type === 'exp' && duration > 3) {
                src.playbackRate.value = 0.6;
                vol = 1.0;
            }
            gain.gain.setValueAtTime(vol, now);

            src.connect(gain);
            gain.connect(this.masterGain);
            src.start(now);

            // Cap rapid-fire weapons so overlapping shots don't turn into mush.
            if (cfg.maxDur && cfg.maxDur < buffer.duration) {
                gain.gain.setValueAtTime(vol, now + cfg.maxDur);
                gain.gain.exponentialRampToValueAtTime(0.001, now + cfg.maxDur + 0.04);
                src.stop(now + cfg.maxDur + 0.05);
            }
        },
        // --- Looping sounds (e.g. helicopter rotor) ---
        // Reference counted: each active source bumps the count and the loop
        // gets a touch louder; the loop stops once the count returns to zero.
        startLoop: function(type, vol) {
            if (!this.ctx) return;
            let L = this.loops[type];
            if (!L) L = this.loops[type] = { src: null, gain: null, count: 0, vol: vol || 0.4 };
            L.count++;
            this._ensureLoop(type);
        },
        stopLoop: function(type) {
            const L = this.loops[type];
            if (!L) return;
            L.count = Math.max(0, L.count - 1);
            if (L.count > 0 && L.gain) {
                L.gain.gain.value = Math.min(0.75, L.vol * (1 + 0.25 * (L.count - 1)));
            } else if (L.count === 0 && L.src) {
                try { L.src.stop(); } catch (e) {}
                L.src.disconnect(); L.gain.disconnect();
                L.src = null; L.gain = null;
            }
        },
        stopAllLoops: function() {
            Object.keys(this.loops).forEach(type => {
                const L = this.loops[type];
                if (L.src) { try { L.src.stop(); } catch (e) {} L.src.disconnect(); L.gain.disconnect(); }
                L.src = null; L.gain = null; L.count = 0;
            });
        },
        // Starts (or restarts) the underlying looping source if one is wanted
        // and the buffer is ready. Called again from loadAll once decoded.
        _ensureLoop: function(type) {
            const L = this.loops[type];
            if (!this.ctx || !L || L.count <= 0 || L.src) return;
            const buffer = this.buffers[type];
            if (!buffer) return; // buffer not decoded yet; loadAll will retry
            const src = this.ctx.createBufferSource();
            src.buffer = buffer;
            src.loop = true;
            const gain = this.ctx.createGain();
            gain.gain.value = Math.min(0.75, L.vol * (1 + 0.25 * (L.count - 1)));
            src.connect(gain);
            gain.connect(this.masterGain);
            src.start();
            L.src = src; L.gain = gain;
        }
    };

    // --- UI Elements ---
    const ui = {
        killCount: document.getElementById('kill-count'),
        waveCount: document.getElementById('wave-count'),
        ptsCount: document.getElementById('pts-count'),
        coordDisplay: document.getElementById('coord-display'),
        bunkerFill: document.getElementById('bunker-health-fill'),
        weaponName: document.getElementById('weapon-name'),
        weaponBtns: document.querySelectorAll('.weapon-btn'),
        supportBtns: document.querySelectorAll('.support-btn'),
        startMenu: document.getElementById('start-menu'),
        pauseMenu: document.getElementById('pause-menu'),
        gameOverMenu: document.getElementById('game-over-menu'),
        victoryScreen: document.getElementById('victory-screen'),
        crosshairCanvas: document.getElementById('crosshair'),
        whiteFlash: document.getElementById('white-flash'),
        cinematicTop: document.getElementById('cinematic-top'),
        cinematicBottom: document.getElementById('cinematic-bottom'),
        hudGroup: document.getElementById('hud'),
        weaponSelectorGroup: document.getElementById('weapon-selector'),
        supportPanelGroup: document.getElementById('support-panel'),
        btnPause: document.getElementById('btn-pause')
    };
    const crossCtx = ui.crosshairCanvas.getContext('2d');
    ui.crosshairCanvas.width = 100;
    ui.crosshairCanvas.height = 100;

    // --- Game State ---
    let gameState = {
        isRunning: false,
        isPaused: false,
        isGameOver: false,
        nukeActive: false,
        kills: 0,
        points: 0,
        wave: 1,
        orbitAngle: 0,
        shakeAmount: 0,
        titanSpawnedThisWave: false
    };

    let targetFov = 45;
    const supportState = { mines: [], infantry: [], helis: [], snipers: 0, lastSniperFire: 0 };
    let tracers = [];
    let nukeObj = null;

    const bunkerStats = { hp: 100, maxHp: 100, radius: 15 };

    // Weapons
    const weapons = [
        { name: "25mm GATLING", type: 'auto', cooldown: 80, blastRadius: 10, travelTime: 0.5, damage: 30, spread: 8, audio: '25', dur: 0.2 },
        { name: "40mm BOFORS", type: 'semi', cooldown: 500, blastRadius: 25, travelTime: 0.8, damage: 80, spread: 2, audio: '40', dur: 0.5 },
        { name: "105mm HOWITZER", type: 'semi', cooldown: 3500, blastRadius: 60, travelTime: 1.5, damage: 500, spread: 0, audio: '105', dur: 1.5, shake: 0.5 }
    ];
    let currentWeaponIdx = 0;
    let canFireSemi = true;

    // Input
    const mouse = { x: window.innerWidth/2, y: window.innerHeight/2, isDown: false };
    const crosshair = { x: window.innerWidth/2, y: window.innerHeight/2 };
    const raycaster = new THREE.Raycaster();
    const targetVector = new THREE.Vector2();

    // --- Three.js Setup ---
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x000000, 0.0005);

    const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 2000);
    const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('webgl-canvas'), antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // FLIR Materials
    const matGround = new THREE.MeshBasicMaterial({ color: 0x222222 });
    const matBuilding = new THREE.MeshBasicMaterial({ color: 0x3a3a3a });
    const matBunker = new THREE.MeshBasicMaterial({ color: 0x555555 });
    const matProjectile = new THREE.MeshBasicMaterial({ color: 0xaaaaaa });
    const matSupport = new THREE.MeshBasicMaterial({ color: 0x888888 });
    const matTracer = new THREE.LineBasicMaterial({ color: 0xffffff });
    const matExplosion = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1.0 });
    const matResidue = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false });
    const matSmoke = new THREE.MeshBasicMaterial({ color: 0x444444, transparent: true, opacity: 0.6 });

    // Environment Objects
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), matGround);
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    const bunkerMesh = new THREE.Group();
    const mainHall = new THREE.Mesh(new THREE.BoxGeometry(30, 20, 40), matBunker);
    mainHall.position.y = 10;
    const tower = new THREE.Mesh(new THREE.BoxGeometry(15, 40, 15), matBunker);
    tower.position.set(0, 20, -15);
    bunkerMesh.add(mainHall);
    bunkerMesh.add(tower);
    scene.add(bunkerMesh);

    // Decorative Buildings
    let buildings = [];
    let smokeParticles = [];

    function initBuildings() {
        buildings.forEach(b => { scene.remove(b.mesh); });
        buildings = [];
        for(let i=0; i<30; i++) {
            const w = 20 + Math.random() * 40;
            const h = 20 + Math.random() * 60;
            const d = 20 + Math.random() * 40;
            const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), matBuilding);

            let bx = (Math.random() - 0.5) * 1000;
            let bz = (Math.random() - 0.5) * 1000;
            if(Math.abs(bx) < 100 && Math.abs(bz) < 100) bx += 150;

            b.position.set(bx, h/2, bz);
            scene.add(b);
            buildings.push({ mesh: b, active: true, dy: 0, w: w, h: h, d: d });
        }
    }
    initBuildings();

    function destroyBuilding(b) {
        if (!b.active) return;
        b.active = false;
        AudioSys.playNoise(1.0, 'collapse');
        for(let j=0; j<8; j++) {
            const sm = new THREE.Mesh(new THREE.SphereGeometry(10+Math.random()*10, 8, 8), matSmoke);
            sm.position.copy(b.mesh.position);
            sm.position.y += Math.random() * b.h;
            sm.position.x += (Math.random() - 0.5) * b.w;
            sm.position.z += (Math.random() - 0.5) * b.d;
            scene.add(sm);
            smokeParticles.push({
                mesh: sm, life: 1.0, decay: 0.1 + Math.random()*0.1,
                vx: (Math.random() - 0.5) * 5, vy: 5 + Math.random() * 10, vz: (Math.random() - 0.5) * 5
            });
        }
    }

    // Entities Arrays
    let zombies = [];
    let projectiles = [];
    let explosions = [];
    let residues = [];

    // ZOMBIE CONFIGURATION (Massive HP Boost applied)
    const Z_TYPES = {
        shambler:   { hp: 100, speed: 6, scale: 1, color: 0xffffff, weight: 100, minWave: 1 },
        runner:     { hp: 75, speed: 18, scale: 0.8, color: 0xffffaa, weight: 30, minWave: 2 },
        crawler:    { hp: 50, speed: 4, scale: 0.5, color: 0xaaffaa, weight: 20, minWave: 1, isFlat: true },
        brute:      { hp: 800, speed: 5, scale: 1.5, color: 0xffcccc, weight: 15, minWave: 3 },
        juggernaut: { hp: 2000, speed: 3, scale: 1.8, color: 0x888888, weight: 5, minWave: 5 },
        bloater:    { hp: 150, speed: 4, scale: 1.3, color: 0xccffcc, weight: 10, minWave: 4, isBloater: true },
        shield:     { hp: 300, speed: 5, scale: 1.1, color: 0xffffff, weight: 15, minWave: 3, hasShield: true },
        soldier:    { hp: 250, speed: 8, scale: 1, color: 0xddddff, weight: 15, minWave: 4 },
        bomber:     { hp: 80, speed: 22, scale: 1, color: 0xffff00, weight: 8, minWave: 5, isBomber: true },
        rpg:        { hp: 200, speed: 4, scale: 1, color: 0xffaa00, weight: 5, minWave: 6, isRpg: true },
        titan:      { hp: 12000, speed: 2.5, scale: 4, color: 0xffffff, weight: 0, minWave: 10, isTitan: true }
    };

    // --- Input Handling ---
    function onPointerMove(e) {
        if(e.touches) { mouse.x = e.touches[0].clientX; mouse.y = e.touches[0].clientY; }
        else { mouse.x = e.clientX; mouse.y = e.clientY; }
    }
    function onPointerDown(e) {
        if(!gameState.isRunning || gameState.isPaused || gameState.nukeActive) return;
        if (e.target && (e.target.tagName.toLowerCase() === 'button' || e.target.closest('.weapon-btn') || e.target.closest('.support-btn'))) return;
        mouse.isDown = true;
        onPointerMove(e);
        if(e.touches) { crosshair.x = mouse.x; crosshair.y = mouse.y; }
        if(weapons[currentWeaponIdx].type === 'semi') fireWeapon();
    }
    function onPointerUp() { mouse.isDown = false; canFireSemi = true; }

    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('mouseup', onPointerUp);
    renderer.domElement.addEventListener('touchstart', (e) => { e.preventDefault(); onPointerDown(e); }, {passive: false});
    renderer.domElement.addEventListener('touchmove', (e) => { e.preventDefault(); onPointerMove(e); }, {passive: false});
    renderer.domElement.addEventListener('touchend', (e) => { e.preventDefault(); onPointerUp(); }, {passive: false});

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    let cheatBuffer = '';
    let cheatActive = false;
    window.addEventListener('keydown', (e) => {
        if(!gameState.nukeActive && gameState.isRunning) {
            if(e.key === '1') selectWeapon(0);
            if(e.key === '2') selectWeapon(1);
            if(e.key === '3') selectWeapon(2);
            if(e.key === 'Escape' && !gameState.isGameOver) togglePause();
        }

        if (e.key.length === 1) {
            cheatBuffer += e.key.toLowerCase();
            if (cheatBuffer.length > 3) cheatBuffer = cheatBuffer.slice(-3);
            if (cheatBuffer === 'wub' && !cheatActive) {
                cheatActive = true;
                weapons.forEach(w => w.cooldown = 0);
                updatePoints(999999);
                ui.ptsCount.innerText = "UNLIMITED";
            }
        }
    });

    window.addEventListener('wheel', (e) => {
        if(!gameState.isRunning || gameState.isPaused || gameState.nukeActive) return;
        targetFov += e.deltaY * 0.05;
        targetFov = Math.max(15, Math.min(80, targetFov));
    });

    ui.weaponBtns.forEach(btn => btn.addEventListener('click', () => selectWeapon(parseInt(btn.getAttribute('data-index')))));
    ui.supportBtns.forEach(btn => btn.addEventListener('click', () => buySupport(btn.getAttribute('data-type'), parseInt(btn.getAttribute('data-cost')))));
    document.getElementById('start-btn').addEventListener('click', startGame);
    document.getElementById('restart-btn').addEventListener('click', startGame);
    document.getElementById('replay-btn').addEventListener('click', startGame);
    document.getElementById('btn-pause').addEventListener('click', togglePause);
    document.getElementById('resume-btn').addEventListener('click', togglePause);

    function selectWeapon(idx) {
        currentWeaponIdx = idx;
        ui.weaponBtns.forEach((b, i) => { if(i === idx) b.classList.add('active'); else b.classList.remove('active'); });
        ui.weaponName.innerText = weapons[idx].name;
        drawCrosshair();
    }

    function togglePause() {
        if(!gameState.isRunning || gameState.isGameOver || gameState.nukeActive) return;
        gameState.isPaused = !gameState.isPaused;
        if(gameState.isPaused) {
            ui.pauseMenu.classList.remove('hidden');
            if (AudioSys.ctx) AudioSys.ctx.suspend(); // pause the heli rotor loop too
        }
        else { ui.pauseMenu.classList.add('hidden'); lastTime = performance.now(); if (AudioSys.ctx) AudioSys.ctx.resume(); }
    }

    function updatePoints(amount) {
        if (cheatActive && amount < 0) return;
        gameState.points += amount;
        if (cheatActive) { gameState.points = 999999; ui.ptsCount.innerText = "UNLIMITED"; }
        else ui.ptsCount.innerText = gameState.points;

        ui.supportBtns.forEach(btn => {
            const cost = parseInt(btn.getAttribute('data-cost'));
            if(gameState.points >= cost || cheatActive) btn.classList.add('affordable');
            else btn.classList.remove('affordable');
        });
    }

    function buySupport(type, cost) {
        if (gameState.points < cost || gameState.nukeActive) return;
        updatePoints(-cost);

        if (type === 'nuke') {
            triggerNuke();
        } else if (type === 'mines') {
            for(let i=0; i<5; i++) {
                const angle = Math.random() * Math.PI * 2;
                const dist = bunkerStats.radius + 20 + Math.random() * 60;
                const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 4), matSupport);
                mesh.position.set(Math.cos(angle)*dist, 0.5, Math.sin(angle)*dist);
                scene.add(mesh);
                supportState.mines.push({ mesh, active: true });
            }
        } else if (type === 'infantry') {
            for(let i=0; i<3; i++) {
                const angle = Math.random() * Math.PI * 2;
                const dist = bunkerStats.radius + 15 + Math.random() * 15;
                const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 2), matSupport);
                mesh.position.set(Math.cos(angle)*dist, 2, Math.sin(angle)*dist);
                scene.add(mesh);
                supportState.infantry.push({
                    mesh, state: 'cooldown', fireTimer: 3.0, burstCount: 0,
                    grenadeTimer: 20.0 + Math.random() * 10.0,
                    targetPos: mesh.position.clone(), moveTimer: 0, targetZombie: null
                });
            }
        } else if (type === 'sniper') {
            supportState.snipers++;
        } else if (type === 'heli') {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 4, 18), matSupport);
            scene.add(mesh);
            supportState.helis.push({
                mesh, orbit: Math.random() * Math.PI * 2, state: 'cooldown',
                timer: 3.0, rocketTimer: 5.0, burstCount: 0, targetZombie: null
            });
            AudioSys.startLoop('heli', 0.3);
        }
    }

    function createTracer(start, end) {
        const geo = new THREE.BufferGeometry().setFromPoints([start, end]);
        const line = new THREE.Line(geo, matTracer);
        scene.add(line);
        tracers.push({ mesh: line, life: 0.1 });
    }

    function fireSupportProjectile(startPos, targetPos, type, damage, radius) {
        const pMesh = new THREE.Mesh(new THREE.BoxGeometry(2,2,2), matProjectile);
        pMesh.position.copy(startPos);
        scene.add(pMesh);
        projectiles.push({
            mesh: pMesh, startPos: startPos.clone(), targetPos: targetPos.clone(),
            type: type, travelTime: (type === 'grenade' ? 1.0 : 0.5), elapsed: 0, damage: damage, blastRadius: radius
        });
    }

    // --- Cinematic Nuke Logic ---
    function triggerNuke() {
        gameState.nukeActive = true;

        // Hide UI and show cinematic bars
        ui.hudGroup.classList.add('hide-ui');
        ui.weaponSelectorGroup.classList.add('hide-ui');
        ui.supportPanelGroup.classList.add('hide-ui');
        ui.btnPause.classList.add('hide-ui');
        ui.crosshairCanvas.classList.add('hide-ui');
        ui.cinematicTop.classList.add('active');
        ui.cinematicBottom.classList.add('active');

        // Reset zoom for the cutscene
        targetFov = 45;
        camera.fov = 45;
        camera.updateProjectionMatrix();

        // Remove all zombies instantly
        zombies.forEach(z => scene.remove(z.mesh));
        zombies = [];

        // Spawn falling bomb from extreme height
        const bombGeo = new THREE.CylinderGeometry(5, 5, 30);
        bombGeo.rotateX(Math.PI / 2); // Align with Z-axis for lookAt
        const bomb = new THREE.Mesh(bombGeo, matProjectile);
        bomb.position.set(0, 4000, 0);
        bomb.lookAt(new THREE.Vector3(0,0,0));
        scene.add(bomb);

        nukeObj = { mesh: bomb, phase: 'falling', timer: 0, y: 4000, vy: 0 };
    }

    // --- Game Logic ---
    function get3DTarget() {
        targetVector.x = (crosshair.x / window.innerWidth) * 2 - 1;
        targetVector.y = -(crosshair.y / window.innerHeight) * 2 + 1;
        raycaster.setFromCamera(targetVector, camera);
        const intersects = raycaster.intersectObject(ground);
        if (intersects.length > 0) return intersects[0].point;
        return new THREE.Vector3(0,0,0);
    }

    function fireWeapon() {
        const now = performance.now();
        const wp = weapons[currentWeaponIdx];

        if (!wp.lastFired) wp.lastFired = 0;
        if (now - wp.lastFired >= wp.cooldown) {
            wp.lastFired = now;
            canFireSemi = false;

            const target3D = get3DTarget();
            const angle = Math.random() * Math.PI * 2;
            const r = Math.random() * wp.spread;
            target3D.x += Math.cos(angle) * r;
            target3D.z += Math.sin(angle) * r;

            const pMesh = new THREE.Mesh(new THREE.BoxGeometry(2,10,2), matProjectile);
            // Spawn from camera
            pMesh.position.copy(camera.position);
            pMesh.lookAt(target3D);
            scene.add(pMesh);

            projectiles.push({
                mesh: pMesh, startPos: camera.position.clone(), targetPos: target3D, travelTime: wp.travelTime,
                elapsed: 0, type: 'ac130', weaponIdx: currentWeaponIdx
            });
            AudioSys.playNoise(wp.dur, wp.audio);
        }
    }

    const zombieGeo = new THREE.SphereGeometry(2, 8, 8);
    function spawnZombie(forcedType = null) {
        let typeKey = forcedType;
        if (!typeKey) {
            if (gameState.wave % 10 === 0 && gameState.wave > 0 && !gameState.titanSpawnedThisWave) {
                typeKey = 'titan';
                gameState.titanSpawnedThisWave = true;
            } else {
                let available = Object.keys(Z_TYPES).filter(k => Z_TYPES[k].minWave <= gameState.wave && !Z_TYPES[k].isTitan);
                let totalWeight = available.reduce((sum, key) => sum + Z_TYPES[key].weight, 0);
                let rand = Math.random() * totalWeight;
                for (let key of available) {
                    if (rand < Z_TYPES[key].weight) { typeKey = key; break; }
                    rand -= Z_TYPES[key].weight;
                }
            }
        }

        const zConf = Z_TYPES[typeKey] || Z_TYPES.shambler;
        const count = typeKey === 'soldier' ? Math.floor(3 + Math.random()*3) : 1;

        for(let i=0; i<count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 300 + Math.random() * 100 + (Math.random()*20);

            const mat = new THREE.MeshBasicMaterial({ color: zConf.color });
            const mesh = new THREE.Mesh(zombieGeo, mat);
            mesh.position.set(Math.cos(angle)*dist, 2, Math.sin(angle)*dist);

            if (zConf.isFlat) mesh.scale.set(zConf.scale, zConf.scale*0.3, zConf.scale);
            else mesh.scale.setScalar(zConf.scale);

            if (zConf.hasShield) {
                const shield = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 1), new THREE.MeshBasicMaterial({color: 0x222222}));
                shield.position.z = 2.5;
                mesh.add(shield);
            }

            scene.add(mesh);
            const hpScaling = typeKey === 'titan' ? (1 + gameState.wave * 0.1) : (1 + gameState.wave * 0.2);

            zombies.push({
                mesh: mesh, type: typeKey, hp: zConf.hp * hpScaling, maxHp: zConf.hp * hpScaling,
                speed: zConf.speed * (1 + gameState.wave * 0.05), wobbleOffset: Math.random() * Math.PI * 2,
                rpgTimer: 3.0 + Math.random() * 3.0
            });
        }
    }

    function triggerExplosion(pos, radius, damage, shake) {
        if(shake) gameState.shakeAmount += shake;

        const expMesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 16), matExplosion);
        expMesh.position.copy(pos);
        scene.add(expMesh);
        explosions.push({ mesh: expMesh, maxScale: 1, life: 1.0, decay: 3.0 });

        const resMesh = new THREE.Mesh(new THREE.PlaneGeometry(radius*2.5, radius*2.5), matResidue);
        resMesh.rotation.x = -Math.PI / 2; resMesh.position.set(pos.x, 0.2, pos.z);
        scene.add(resMesh);
        residues.push({ mesh: resMesh, life: 1.0, decay: 0.1 });

        if(radius > 15) AudioSys.playNoise(1.5, 'exp');

        for (let i = zombies.length - 1; i >= 0; i--) {
            const z = zombies[i];
            const dist = z.mesh.position.distanceTo(pos);
            if (dist < radius) {
                const dmgMult = 1 - (dist / radius);
                z.hp -= damage * dmgMult;
            }
        }

        if (pos.length() < radius + bunkerStats.radius) {
            bunkerStats.hp -= damage * 0.3;
            updateBunkerHealth();
        }

        for (let i = supportState.infantry.length - 1; i >= 0; i--) {
            if (supportState.infantry[i].mesh.position.distanceTo(pos) < radius) {
                scene.remove(supportState.infantry[i].mesh);
                supportState.infantry.splice(i, 1);
            }
        }

        for (let i = supportState.helis.length - 1; i >= 0; i--) {
            if (supportState.helis[i].mesh.position.distanceTo(pos) < radius) {
                const hPos = supportState.helis[i].mesh.position.clone();
                scene.remove(supportState.helis[i].mesh);
                supportState.helis.splice(i, 1);
                AudioSys.stopLoop('heli');

                const sExp = new THREE.Mesh(new THREE.SphereGeometry(15, 16, 16), matExplosion);
                sExp.position.copy(hPos); scene.add(sExp);
                explosions.push({ mesh: sExp, maxScale: 1, life: 1.0, decay: 3.0 });
                AudioSys.playNoise(1.0, 'exp');
            }
        }

        if (supportState.snipers > 0 && pos.length() < radius + 15) supportState.snipers--;

        buildings.forEach(b => {
            if(b.active && b.mesh.position.distanceTo(pos) < radius + Math.max(b.w, b.d)/2) destroyBuilding(b);
        });
    }

    function checkWave() {
        if (gameState.kills > 0 && gameState.kills % 30 === 0) {
            gameState.wave++;
            gameState.titanSpawnedThisWave = false;
            ui.waveCount.innerText = gameState.wave;
            bunkerStats.hp = Math.min(bunkerStats.maxHp, bunkerStats.hp + 20);
            updateBunkerHealth();
        }
    }

    function updateBunkerHealth() {
        const pct = Math.max(0, (bunkerStats.hp / bunkerStats.maxHp) * 100);
        ui.bunkerFill.style.width = `${pct}%`;
        if (pct > 50) ui.bunkerFill.style.background = '#fff';
        else if (pct > 20) ui.bunkerFill.style.background = '#ff0';
        else ui.bunkerFill.style.background = '#f00';

        if (bunkerStats.hp <= 0 && !gameState.isGameOver && !gameState.nukeActive) {
            gameState.isGameOver = true;
            AudioSys.stopAllLoops(); // cut the helicopter rotor on death
            ui.gameOverMenu.classList.remove('hidden');
        }
    }

    function drawCrosshair() {
        crossCtx.clearRect(0,0,100,100);
        crossCtx.strokeStyle = 'rgba(255,255,255,0.9)';
        crossCtx.lineWidth = 2;
        const cx = 50, cy = 50;

        crossCtx.beginPath();
        if(currentWeaponIdx === 0) {
            crossCtx.moveTo(cx-15, cy); crossCtx.lineTo(cx+15, cy);
            crossCtx.moveTo(cx, cy-15); crossCtx.lineTo(cx, cy+15);
        } else if(currentWeaponIdx === 1) {
            crossCtx.arc(cx, cy, 20, 0, Math.PI*2);
            crossCtx.moveTo(cx, cy-15); crossCtx.lineTo(cx, cy-25);
            crossCtx.moveTo(cx, cy+15); crossCtx.lineTo(cx, cy+25);
            crossCtx.moveTo(cx-15, cy); crossCtx.lineTo(cx-25, cy);
            crossCtx.moveTo(cx+15, cy); crossCtx.lineTo(cx+25, cy);
        } else {
            const s = 35, l = 15;
            crossCtx.moveTo(cx-s, cy-s+l); crossCtx.lineTo(cx-s, cy-s); crossCtx.lineTo(cx-s+l, cy-s);
            crossCtx.moveTo(cx+s-l, cy-s); crossCtx.lineTo(cx+s, cy-s); crossCtx.lineTo(cx+s, cy-s+l);
            crossCtx.moveTo(cx+s, cy+s-l); crossCtx.lineTo(cx+s, cy+s); crossCtx.lineTo(cx+s-l, cy+s);
            crossCtx.moveTo(cx-s+l, cy+s); crossCtx.lineTo(cx-s, cy+s); crossCtx.lineTo(cx-s, cy+s-l);
            crossCtx.fillRect(cx-2, cy-2, 4, 4);
        }
        crossCtx.stroke();
    }

    let lastTime = performance.now();

    function animate() {
        requestAnimationFrame(animate);
        const now = performance.now();
        const dt = (now - lastTime) / 1000;
        lastTime = now;

        if (!gameState.isRunning || gameState.isPaused || gameState.isGameOver) { renderer.render(scene, camera); return; }

        let shakeX = 0, shakeY = 0, shakeZ = 0;
        if (gameState.shakeAmount > 0) {
            shakeX = (Math.random() - 0.5) * gameState.shakeAmount * 10;
            shakeY = (Math.random() - 0.5) * gameState.shakeAmount * 10;
            shakeZ = (Math.random() - 0.5) * gameState.shakeAmount * 10;
            if(!gameState.nukeActive) {
                gameState.shakeAmount -= dt * 2;
                if(gameState.shakeAmount < 0) gameState.shakeAmount = 0;
            }
        }

        camera.fov += (targetFov - camera.fov) * 0.1;
        camera.updateProjectionMatrix();

        // --- Nuke Cinematic Processing ---
        if (gameState.nukeActive && nukeObj) {
            if (nukeObj.phase === 'falling') {
                // Realistic gravity acceleration
                nukeObj.vy += dt * 400;
                nukeObj.y -= nukeObj.vy * dt;
                nukeObj.mesh.position.y = nukeObj.y;

                // Ground observer looking up at bomb
                camera.position.set(1500, 50, 1500);
                camera.lookAt(0, nukeObj.y * 0.5, 0);

                if (nukeObj.y <= 0) {
                    scene.remove(nukeObj.mesh);
                    nukeObj.phase = 'flash';
                    nukeObj.timer = 0;
                    ui.whiteFlash.style.opacity = '1';

                    // Destroy all buildings instantly
                    buildings.forEach(b => destroyBuilding(b));
                }
            } else if (nukeObj.phase === 'flash') {
                nukeObj.timer += dt;

                // Keep camera locked forward
                camera.position.set(2000, 50, 2000);
                camera.lookAt(0, 100, 0);

                // 1.5 seconds of blinding white silence (light travels faster than sound/shockwave)
                if (nukeObj.timer >= 1.5) {
                    nukeObj.phase = 'expanding';
                    nukeObj.timer = 0;

                    AudioSys.playNoise(10.0, 'exp'); // The Massive Boom arrives

                    const nukeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
                    const nukeRingMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1.0 });

                    nukeObj.stem = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 32), nukeMat);
                    nukeObj.stem.geometry.translate(0, 0.5, 0); // Pivot at base
                    nukeObj.cap = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 32), nukeMat);
                    nukeObj.ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.05, 16, 64), nukeRingMat);
                    nukeObj.ring.rotation.x = Math.PI / 2;

                    scene.add(nukeObj.stem);
                    scene.add(nukeObj.cap);
                    scene.add(nukeObj.ring);

                    setTimeout(() => {
                        ui.victoryScreen.classList.remove('hidden');
                        void ui.victoryScreen.offsetWidth; // Trigger reflow
                        ui.victoryScreen.style.opacity = '1';
                    }, 9000);
                }
            } else if (nukeObj.phase === 'expanding') {
                // SLOW MOTION multiplier (0.25x speed)
                nukeObj.timer += dt * 0.25;
                let t = nukeObj.timer;

                gameState.shakeAmount = Math.max(0, 20.0 - t * 3.5);

                // Grow Stalk
                let stemHeight = Math.min(1200, t * 2000);
                let stemRadius = 40 + t * 60;
                nukeObj.stem.scale.set(stemRadius, stemHeight, stemRadius);

                // Expand and rise cap (squashed sphere)
                let capHeight = stemHeight;
                let capRadius = 100 + Math.pow(t, 1.4) * 800;
                nukeObj.cap.position.y = capHeight;
                nukeObj.cap.scale.set(capRadius, capRadius * 0.6, capRadius);

                // Ground shockwave ring
                let ringRadius = t * 3500;
                nukeObj.ring.scale.setScalar(ringRadius);
                nukeObj.ring.material.opacity = Math.max(0, 1 - t * 0.4);

                // Thermal color transition (White -> Yellow -> Orange -> Dark Smoke)
                let color = new THREE.Color(0xffffff);
                if (t > 0.5 && t <= 2.0) color.lerp(new THREE.Color(0xffaa00), (t - 0.5)/1.5);
                else if (t > 2.0 && t <= 4.0) color.lerp(new THREE.Color(0xff3300), (t - 2.0)/2.0);
                else if (t > 4.0) color.lerp(new THREE.Color(0x1a1a1a), Math.min(1, (t - 4.0)*0.25));

                nukeObj.stem.material.color.copy(color);
                nukeObj.cap.material.color.copy(color);
                nukeObj.ring.material.color.copy(color);

                ui.whiteFlash.style.opacity = Math.max(0, 1 - t * 0.8);

                // Majestic slow pan upwards
                let camY = 50 + t * 80;
                camera.position.set(2500 + shakeX, Math.min(camY, 800) + shakeY, 2500 + shakeZ);
                camera.lookAt(0, capHeight * 0.5, 0);
            }
        } else {
            // Standard AC-130 Orbiting Camera
            gameState.orbitAngle += dt * 0.05;
            const radius = 600;
            const camX = Math.cos(gameState.orbitAngle) * radius;
            const camZ = Math.sin(gameState.orbitAngle) * radius;
            camera.position.set(camX + shakeX, 500 + shakeY, camZ + shakeZ);
            camera.lookAt(0, 0, 0);
        }

        // Camera Dynamics (Crosshair Lag)
        crosshair.x += (mouse.x - crosshair.x) * (dt * 10);
        crosshair.y += (mouse.y - crosshair.y) * (dt * 10);
        ui.crosshairCanvas.style.left = `${crosshair.x}px`;
        ui.crosshairCanvas.style.top = `${crosshair.y}px`;

        // --- Standard Gameplay Loop (Halted during Nuke) ---
        if (!gameState.nukeActive) {
            if (mouse.isDown && weapons[currentWeaponIdx].type === 'auto') fireWeapon();

            weapons.forEach((wp, idx) => {
                const el = document.getElementById(`cd-${idx}`);
                const elapsed = now - (wp.lastFired||0);
                if(elapsed < wp.cooldown) el.style.width = `${100 - (elapsed/wp.cooldown)*100}%`;
                else el.style.width = `0%`;
            });

            // Update Projectiles (AC130, Grenades, Rockets, RPGs)
            for(let i = projectiles.length - 1; i >= 0; i--) {
                const p = projectiles[i];
                p.elapsed += dt;
                const t = p.elapsed / p.travelTime;

                if(t >= 1.0) {
                    if (p.type === 'ac130') {
                        const wp = weapons[p.weaponIdx];
                        triggerExplosion(p.targetPos, wp.blastRadius, wp.damage, wp.shake);
                    } else if (p.type === 'grenade' || p.type === 'rocket' || p.type === 'rpg') {
                        triggerExplosion(p.targetPos, p.blastRadius, p.damage, (p.type==='rpg' ? 0.5 : 0.1));
                    }
                    scene.remove(p.mesh);
                    projectiles.splice(i, 1);
                } else {
                    if (p.type === 'ac130') {
                        p.mesh.position.lerpVectors(p.startPos, p.targetPos, t);
                    } else if (p.type === 'grenade') {
                        p.mesh.position.lerpVectors(p.startPos, p.targetPos, t);
                        p.mesh.position.y += Math.sin(t * Math.PI) * 15; // Arc
                    } else {
                        p.mesh.position.lerpVectors(p.startPos, p.targetPos, t); // Straight line
                    }
                }
            }

            for (let i = supportState.mines.length - 1; i >= 0; i--) {
                const m = supportState.mines[i];
                for (let j = 0; j < zombies.length; j++) {
                    if (m.mesh.position.distanceTo(zombies[j].mesh.position) < 15) {
                        triggerExplosion(m.mesh.position, 30, 100, 0.1);
                        scene.remove(m.mesh); supportState.mines.splice(i, 1); break;
                    }
                }
            }

            const getNearestZombie = (pos, maxDist) => {
                let nearest = null, minDist = maxDist;
                zombies.forEach(z => { const d = z.mesh.position.distanceTo(pos); if (d < minDist) { minDist = d; nearest = z; }});
                return nearest;
            };

            supportState.infantry.forEach(inf => {
                inf.moveTimer -= dt;
                if (inf.moveTimer <= 0) {
                    const angle = Math.random() * Math.PI * 2;
                    const dist = bunkerStats.radius + 10 + Math.random() * 20;
                    inf.targetPos.set(Math.cos(angle)*dist, 2, Math.sin(angle)*dist);
                    inf.moveTimer = 2 + Math.random() * 3;
                }

                const dir = new THREE.Vector3().subVectors(inf.targetPos, inf.mesh.position);
                if (dir.length() > 0.5) {
                    dir.normalize();
                    inf.mesh.position.addScaledVector(dir, 15 * dt);
                    inf.mesh.lookAt(inf.targetPos.x, inf.mesh.position.y, inf.targetPos.z);
                }

                // Rigid collision for church bounds (Infantry)
                const minInfantryDist = 25;
                if (inf.mesh.position.length() < minInfantryDist) {
                    inf.mesh.position.normalize().multiplyScalar(minInfantryDist);
                }

                inf.grenadeTimer -= dt;
                inf.fireTimer -= dt;

                if (inf.grenadeTimer <= 0) {
                    const z = getNearestZombie(inf.mesh.position, 100);
                    if (z) {
                        inf.grenadeTimer = 20.0 + Math.random() * 10.0; // Heavily limited
                        fireSupportProjectile(inf.mesh.position, z.mesh.position, 'grenade', 150, 20);
                        AudioSys.playNoise(0.2, '40');
                    }
                }

                // Infantry 5-round burst logic
                if (inf.state === 'cooldown' && inf.fireTimer <= 0) {
                    inf.state = 'firing'; inf.burstCount = 5; inf.fireTimer = 0.1;
                    inf.targetZombie = getNearestZombie(inf.mesh.position, 150);
                } else if (inf.state === 'firing' && inf.fireTimer <= 0) {
                    if (!inf.targetZombie || inf.targetZombie.hp <= 0 || !zombies.includes(inf.targetZombie)) {
                        inf.targetZombie = getNearestZombie(inf.mesh.position, 150);
                    }

                    if (inf.targetZombie) {
                        createTracer(inf.mesh.position, inf.targetZombie.mesh.position);
                        inf.targetZombie.hp -= 20;
                        AudioSys.playNoise(0.1, 'rifle');
                        inf.mesh.lookAt(inf.targetZombie.mesh.position.x, inf.mesh.position.y, inf.targetZombie.mesh.position.z);
                    }

                    inf.burstCount--;
                    if(inf.burstCount <= 0) { inf.state = 'cooldown'; inf.fireTimer = 3.0; }
                    else { inf.fireTimer = 0.1; }
                }
            });

            supportState.helis.forEach(h => {
                h.orbit += dt * 0.5;
                const hx = Math.cos(h.orbit) * 180;
                const hz = Math.sin(h.orbit) * 180;
                h.mesh.position.set(hx, 80, hz);
                h.mesh.lookAt(0, 80, 0);

                h.timer -= dt;
                h.rocketTimer -= dt;

                if (h.rocketTimer <= 0) {
                    const z = getNearestZombie(h.mesh.position, 300);
                    if (z) {
                        h.rocketTimer = 8.0;
                        fireSupportProjectile(h.mesh.position, z.mesh.position, 'rocket', 200, 30);
                        AudioSys.playNoise(0.3, '105');
                    }
                }

                // Heli 5-round burst logic
                if(h.state === 'cooldown' && h.timer <= 0) {
                    h.state = 'firing'; h.burstCount = 5; h.timer = 0.1;
                    h.targetZombie = getNearestZombie(h.mesh.position, 250);
                } else if (h.state === 'firing' && h.timer <= 0) {
                    if (!h.targetZombie || h.targetZombie.hp <= 0 || !zombies.includes(h.targetZombie)) {
                        h.targetZombie = getNearestZombie(h.mesh.position, 250);
                    }

                    if (h.targetZombie) {
                        createTracer(h.mesh.position, h.targetZombie.mesh.position);
                        h.targetZombie.hp -= 40;
                        AudioSys.playNoise(0.1, '25');
                    }

                    h.burstCount--;
                    if(h.burstCount <= 0) { h.state = 'cooldown'; h.timer = 3.0; }
                    else { h.timer = 0.1; }
                }
            });

            if (supportState.snipers > 0 && now - supportState.lastSniperFire > 2000) {
                supportState.lastSniperFire = now;
                for(let i=0; i<supportState.snipers; i++) {
                    if (zombies.length > i) {
                        const targetIdx = Math.floor(Math.random() * zombies.length);
                        const z = zombies[targetIdx];
                        const towerPos = new THREE.Vector3(0, 20, -15);
                        createTracer(towerPos, z.mesh.position);
                        z.hp -= 250;
                        AudioSys.playNoise(0.3, '105');
                    }
                }
            }

            for(let i = tracers.length - 1; i >= 0; i--) {
                tracers[i].life -= dt;
                if(tracers[i].life <= 0) { tracers[i].mesh.geometry.dispose(); scene.remove(tracers[i].mesh); tracers.splice(i, 1); }
            }

            for(let i = zombies.length - 1; i >= 0; i--) {
                const z = zombies[i];

                if (z.hp <= 0) {
                    if (z.type === 'bloater') triggerExplosion(z.mesh.position, 35, 100, 0);
                    scene.remove(z.mesh);
                    zombies.splice(i, 1);
                    gameState.kills++;
                    ui.killCount.innerText = gameState.kills;
                    updatePoints(1);
                    checkWave();
                    continue;
                }

                const dist = z.mesh.position.length();

                if (z.type === 'bomber' && dist < bunkerStats.radius + 15) {
                    triggerExplosion(z.mesh.position, 30, 80, 0.5);
                    z.hp = 0; continue;
                }
                if (z.type === 'rpg') {
                    z.rpgTimer -= dt;
                    if (z.rpgTimer <= 0) {
                        z.rpgTimer = 5.0 + Math.random() * 3.0;
                        if (supportState.helis.length > 0) {
                            fireSupportProjectile(z.mesh.position, supportState.helis[0].mesh.position, 'rpg', 100, 15);
                        } else {
                            fireSupportProjectile(z.mesh.position, new THREE.Vector3((Math.random()-0.5)*100, 300, (Math.random()-0.5)*100), 'rpg', 0, 0);
                            gameState.shakeAmount += 1.0;
                            ui.ptsCount.style.color = '#f00'; setTimeout(()=>ui.ptsCount.style.color='#fff', 300);
                        }
                    }
                }
                if (z.type === 'titan') {
                    buildings.forEach(b => {
                        if (b.active && z.mesh.position.distanceTo(b.mesh.position) < 30) destroyBuilding(b);
                    });
                }

                // Movement & Collision
                if (dist > bunkerStats.radius) {
                    const dir = z.mesh.position.clone().normalize().negate();
                    const wobble = Math.sin(now/200 + z.wobbleOffset) * 0.5;
                    const perpDir = new THREE.Vector3(-dir.z, 0, dir.x);

                    z.mesh.position.addScaledVector(dir, z.speed * dt);
                    z.mesh.position.addScaledVector(perpDir, wobble * dt * z.speed);
                    z.mesh.lookAt(0, z.mesh.position.y, 0);

                    // Enforce rigid collision for church structure
                    if (z.mesh.position.length() < bunkerStats.radius + 2) {
                        z.mesh.position.normalize().multiplyScalar(bunkerStats.radius + 2);
                    }

                    const brightness = 0.4 + (z.hp/z.maxHp)*0.6;
                    const baseColor = new THREE.Color(Z_TYPES[z.type].color);
                    z.mesh.material.color.setRGB(baseColor.r * brightness, baseColor.g * brightness, baseColor.b * brightness);
                } else {
                    z.mesh.position.normalize().multiplyScalar(bunkerStats.radius + 2);
                    bunkerStats.hp -= (z.type==='titan' ? 30 : 5) * dt;
                    updateBunkerHealth();
                }
            }

            if (Math.random() < (0.01 + gameState.wave * 0.003)) spawnZombie();
            if(Math.random() < 0.1) ui.coordDisplay.innerText = `N 34° 51' ${40+Math.floor(Math.random()*5)}" E 44° 4' ${10+Math.floor(Math.random()*5)}"`;
        }

        // Shared updates
        for(let i = explosions.length - 1; i >= 0; i--) {
            const exp = explosions[i];
            exp.life -= dt * exp.decay;
            if(exp.life <= 0) { scene.remove(exp.mesh); explosions.splice(i, 1); }
            else { const s = 1 - exp.life; exp.mesh.scale.set(s, s, s); exp.mesh.material.opacity = exp.life; }
        }

        for(let i = residues.length - 1; i >= 0; i--) {
            const r = residues[i];
            r.life -= dt * r.decay;
            if(r.life <= 0) { scene.remove(r.mesh); residues.splice(i, 1); }
            else { r.mesh.material.opacity = r.life * 0.8; }
        }

        buildings.forEach(b => {
            if(!b.active && b.mesh.position.y > -100) {
                b.dy -= dt * 15;
                b.mesh.position.y += b.dy * dt;
                b.mesh.rotation.x += dt * 0.2;
                b.mesh.rotation.z += dt * 0.2;
            }
        });

        for(let i = smokeParticles.length - 1; i >= 0; i--) {
            const sp = smokeParticles[i];
            sp.life -= dt * sp.decay;
            if(sp.life <= 0) { scene.remove(sp.mesh); smokeParticles.splice(i, 1); }
            else {
                sp.mesh.position.x += sp.vx * dt; sp.mesh.position.y += sp.vy * dt; sp.mesh.position.z += sp.vz * dt;
                const s = 1 + (1 - sp.life) * 2; sp.mesh.scale.set(s, s, s);
            }
        }

        renderer.render(scene, camera);
    }

    function startGame() {
        AudioSys.init();

        zombies.forEach(z => scene.remove(z.mesh));
        projectiles.forEach(p => scene.remove(p.mesh));
        explosions.forEach(e => scene.remove(e.mesh));
        residues.forEach(r => scene.remove(r.mesh));
        smokeParticles.forEach(sp => scene.remove(sp.mesh));
        zombies = []; projectiles = []; explosions = []; residues = []; smokeParticles = [];

        initBuildings();

        supportState.mines.forEach(m => scene.remove(m.mesh));
        supportState.infantry.forEach(i => scene.remove(i.mesh));
        supportState.helis.forEach(h => scene.remove(h.mesh));
        tracers.forEach(t => scene.remove(t.mesh));
        supportState.mines = []; supportState.infantry = []; supportState.helis = [];
        supportState.snipers = 0; tracers = [];
        AudioSys.stopAllLoops(); // silence any helicopter rotor loops from the previous run

        if(nukeObj) {
            if(nukeObj.stem) scene.remove(nukeObj.stem);
            if(nukeObj.cap) scene.remove(nukeObj.cap);
            if(nukeObj.ring) scene.remove(nukeObj.ring);
            if(nukeObj.mesh) scene.remove(nukeObj.mesh);
            nukeObj = null;
        }

        // Restore UI visibility and hide cinematic bars
        ui.hudGroup.classList.remove('hide-ui');
        ui.weaponSelectorGroup.classList.remove('hide-ui');
        ui.supportPanelGroup.classList.remove('hide-ui');
        ui.btnPause.classList.remove('hide-ui');
        ui.crosshairCanvas.classList.remove('hide-ui');
        ui.cinematicTop.classList.remove('active');
        ui.cinematicBottom.classList.remove('active');

        gameState.isRunning = true; gameState.isPaused = false; gameState.isGameOver = false; gameState.nukeActive = false;
        gameState.kills = 0; gameState.points = 0; gameState.wave = 1; gameState.titanSpawnedThisWave = false;
        bunkerStats.hp = bunkerStats.maxHp;

        targetFov = 45; camera.fov = 45; camera.updateProjectionMatrix();
        cheatActive = false; cheatBuffer = '';
        weapons[0].cooldown = 80; weapons[1].cooldown = 500; weapons[2].cooldown = 3500;

        ui.killCount.innerText = '0'; ui.waveCount.innerText = '1';
        updatePoints(0); updateBunkerHealth();

        ui.startMenu.classList.add('hidden');
        ui.gameOverMenu.classList.add('hidden');
        ui.pauseMenu.classList.add('hidden');
        ui.victoryScreen.classList.add('hidden');
        ui.victoryScreen.style.opacity = '0';
        ui.whiteFlash.style.opacity = '0';

        selectWeapon(0);
        lastTime = performance.now();
    }

    drawCrosshair();
    animate();
};
