/* Bravemania creatures: one controller for the creature videos and their sounds.
   - Every video is muted. All audio goes through this file, one voice at a time.
   - All creatures follow one shared 21-second clock, so timings come from the approved clips.
   - Sound is off until the visitor presses the button. Motion stops when the hero is off screen or the tab is hidden.
   - Without JavaScript, WebGL or permission to move, the transparent poster images simply stay in place. */
(function () {
    'use strict';

    var CYCLE = 21;
    var BASE = '/assets/creatures/';
    // offset: where each creature's clip starts on the shared clock. Clip times are measured from the approved footage.
    var CREATURES = {
        rex: { offset: 0, sound: 't-rex-roar.mp3', soundAt: 3.2, gain: 0.8 },
        manticore: { offset: 6.7, sound: 'manticore-roar.mp3', soundAt: 3.6, gain: 0.85 },
        dragon: { offset: 14.8, sound: 'dragon-fire.mp3', soundAt: 1.5, gain: 0.7 }
    };

    var root = document.documentElement;
    var stage = document.querySelector('[data-creature-stage]');
    var toggle = document.getElementById('sound-toggle');

    /* ---------- Phone menu ---------- */
    (function () {
        var button = document.getElementById('menu-toggle');
        var menu = document.getElementById('site-menu');
        if (!button || !menu) { return; }
        root.classList.add('menu-ready');
        function set(open) {
            menu.classList.toggle('is-open', open);
            button.setAttribute('aria-expanded', open ? 'true' : 'false');
            button.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
        }
        button.addEventListener('click', function () { set(!menu.classList.contains('is-open')); });
        menu.addEventListener('click', function (e) { if (e.target.closest('a')) { set(false); } });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && menu.classList.contains('is-open')) { set(false); button.focus(); }
        });
        document.addEventListener('click', function (e) {
            if (menu.classList.contains('is-open') && !e.target.closest('nav')) { set(false); }
        });
    })();

    if (!stage) { return; }

    var pageGain = Number(stage.getAttribute('data-sound-level')) || 1;
    var motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    var phoneQuery = window.matchMedia('(max-width: 768px)');
    var layers = [];
    var byName = {};
    var clock = 0;
    var lastNow = 0;
    var running = false;
    var inView = true;
    var soundWanted = false;
    var audio = null;
    var voice = null;
    var frame = 0;
    var started = false;
    var log = [];

    function connectionAllowsVideo() {
        var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (!c) { return true; }
        if (c.saveData) { return false; }
        return !/(^|-)(2g|slow-2g|3g)$/.test(c.effectiveType || '');
    }

    function motionAllowed() {
        return !motionQuery.matches && connectionAllowsVideo();
    }

    function mod(v, m) {
        return ((v % m) + m) % m;
    }

    /* ---------- WebGL drawing: colour is the top half of the video, alpha the bottom half ---------- */
    var VERT = 'attribute vec2 p;varying vec2 v;void main(){v=vec2(p.x*.5+.5,.5-p.y*.5);gl_Position=vec4(p,0.,1.);}';
    var FRAG = 'precision mediump float;varying vec2 v;uniform sampler2D t;void main(){' +
        'vec3 c=texture2D(t,vec2(v.x,v.y*.5)).rgb;' +
        'float a=texture2D(t,vec2(v.x,v.y*.5+.5)).r;' +
        'a=clamp((a-.04)/.92,0.,1.);' +
        'gl_FragColor=vec4(min(c,vec3(a)),a);}';

    function setupGL(canvas) {
        var opts = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' };
        var gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
        if (!gl) { return null; }
        function shader(type, src) {
            var s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            return s;
        }
        var prog = gl.createProgram();
        gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
        gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { return null; }
        gl.useProgram(prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        var loc = gl.getAttribLocation(prog, 'p');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.clearColor(0, 0, 0, 0);
        return gl;
    }

    function fallBack(layer) {
        layer.failed = true;
        layer.el.classList.remove('is-live');
        if (layer.video) { layer.video.pause(); }
    }

    function createLayer(el) {
        var name = el.getAttribute('data-creature');
        var layer = { el: el, name: name, def: CREATURES[name], canvas: null, gl: null, video: null, drawn: false, failed: false, active: false };
        layers.push(layer);
        byName[name] = layer;
        return layer;
    }

    function ensureVideo(layer) {
        if (layer.video || layer.failed) { return !layer.failed; }
        var canvas = document.createElement('canvas');
        canvas.setAttribute('aria-hidden', 'true');
        var gl = setupGL(canvas);
        if (!gl) { fallBack(layer); return false; }
        var video = document.createElement('video');
        video.muted = true;
        video.defaultMuted = true;
        video.setAttribute('muted', '');
        video.setAttribute('playsinline', '');
        video.setAttribute('webkit-playsinline', '');
        video.setAttribute('disablepictureinpicture', '');
        video.setAttribute('aria-hidden', 'true');
        video.tabIndex = -1;
        video.loop = true;
        video.preload = 'auto';
        video.className = 'creature-source';
        // Round six: sharper builds from the full 1280 x 720 footage (phones 960 x 540, desktop the native 1280 x 720)
        video.src = BASE + layer.name + (phoneQuery.matches ? '-m.mp4' : '-hd.mp4');
        video.addEventListener('error', function () { fallBack(layer); });
        layer.canvas = canvas;
        layer.gl = gl;
        layer.video = video;
        layer.el.appendChild(video);
        layer.el.appendChild(canvas);
        return true;
    }

    function draw(layer) {
        var v = layer.video, gl = layer.gl;
        if (!v || v.readyState < 2 || !v.videoWidth) { return; }
        var w = v.videoWidth, h = v.videoHeight / 2;
        if (layer.canvas.width !== w || layer.canvas.height !== h) {
            layer.canvas.width = w;
            layer.canvas.height = h;
            gl.viewport(0, 0, w, h);
        }
        try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, v);
        } catch (err) {
            fallBack(layer);
            return;
        }
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        if (!layer.drawn) {
            layer.drawn = true;
            layer.el.classList.add('is-live');
        }
    }

    /* ---------- Shared clock ---------- */
    function clipTime(layer, at) {
        return mod(at - layer.def.offset, CYCLE);
    }

    function follow(layer) {
        var v = layer.video;
        if (!v || v.readyState < 1) { return; }
        var want = clipTime(layer, clock);
        // A seek that has not finished after four seconds is asked for again, so no creature stays frozen
        if (v.seeking) {
            if (!layer.seekStart) { layer.seekStart = performance.now(); }
            if (performance.now() - layer.seekStart > 4000) {
                layer.seekStart = performance.now();
                v.currentTime = want;
            }
            return;
        }
        layer.seekStart = 0;
        var d = v.currentTime - want;
        if (d > CYCLE / 2) { d -= CYCLE; }
        if (d < -CYCLE / 2) { d += CYCLE; }
        var abs = Math.abs(d);
        if (abs > 0.35) {
            v.currentTime = want;
            v.playbackRate = 1;
        } else if (abs > 0.05) {
            v.playbackRate = d > 0 ? 0.96 : 1.04;
        } else if (v.playbackRate !== 1) {
            v.playbackRate = 1;
        }
    }
    function loop(now) {
        frame = 0;
        if (!running) { return; }
        var dt = Math.min((now - lastNow) / 1000, 0.25);
        lastNow = now;
        clock = mod(clock + dt, CYCLE);
        for (var i = 0; i < layers.length; i++) {
            var l = layers[i];
            if (l.active && !l.failed && !l.blocked) {
                follow(l);
                draw(l);
            }
        }
        runVoices();
        frame = requestAnimationFrame(loop);
    }

    function wantedLayers() {
        // Phones run the Manticore alone until the visitor asks for sound, which brings in the other two
        return layers.filter(function (l) {
            return soundWanted || !phoneQuery.matches || l.name === 'manticore';
        });
    }

    function play() {
        if (running || !inView || document.hidden || !motionAllowed()) { return; }
        var want = wantedLayers();
        want.forEach(function (l) {
            if (l.failed || !ensureVideo(l)) { return; }
            l.active = true;
            l.video.currentTime = l.video.readyState >= 1 ? clipTime(l, clock) : 0;
            var p = l.video.play();
            if (p && p.catch) {
                // Autoplay refused, for example iPhone Low Power Mode: the poster stays until a tap on the sound button
                p.catch(function () { l.blocked = true; });
            }
        });
        running = true;
        lastNow = performance.now();
        if (!frame) { frame = requestAnimationFrame(loop); }
    }

    function pause() {
        running = false;
        if (frame) {
            cancelAnimationFrame(frame);
            frame = 0;
        }
        layers.forEach(function (l) {
            if (l.video) { l.video.pause(); }
        });
        stopVoice(0.25);
    }

    /* ---------- Sound: one controller, one voice at a time ---------- */
    function ensureAudio() {
        if (audio) { return audio; }
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) { return null; }
        var ctx = new Ctx();
        var master = ctx.createGain();
        master.gain.value = pageGain;
        master.connect(ctx.destination);
        audio = { ctx: ctx, master: master, buffers: {} };
        Object.keys(CREATURES).forEach(function (name) {
            fetch(BASE + CREATURES[name].sound)
                .then(function (r) { return r.arrayBuffer(); })
                .then(function (data) {
                    return new Promise(function (ok, no) { ctx.decodeAudioData(data, ok, no); });
                })
                .then(function (buffer) { audio.buffers[name] = buffer; })
                .catch(function () { /* That creature simply stays silent */ });
        });
        return audio;
    }

    function stopVoice(fade) {
        if (!voice || !audio) { return; }
        var v = voice;
        voice = null;
        var t = audio.ctx.currentTime;
        v.gain.gain.cancelScheduledValues(t);
        v.gain.gain.setValueAtTime(v.gain.gain.value, t);
        v.gain.gain.linearRampToValueAtTime(0, t + fade);
        try { v.source.stop(t + fade + 0.02); } catch (err) { /* already ended */ }
        v.endedAt = clock;
        log.push({ event: 'stop', name: v.name, clock: +clock.toFixed(2) });
    }

    function startVoice(name, delay, offset) {
        var layer = byName[name];
        var buffer = audio.buffers[name];
        if (!buffer || voice) { return; }
        var ctx = audio.ctx;
        var src = ctx.createBufferSource();
        var gain = ctx.createGain();
        var when = ctx.currentTime + delay;
        src.buffer = buffer;
        gain.gain.setValueAtTime(offset > 0.05 ? 0 : layer.def.gain, when);
        if (offset > 0.05) { gain.gain.linearRampToValueAtTime(layer.def.gain, when + 0.25); }
        src.connect(gain);
        gain.connect(audio.master);
        var current = { name: name, source: src, gain: gain, startedClock: clock + delay };
        voice = current;
        src.onended = function () {
            if (voice === current) {
                voice = null;
                log.push({ event: 'end', name: name, clock: +clock.toFixed(2) });
            }
        };
        src.start(when, offset);
        log.push({ event: 'start', name: name, clock: +(clock + delay).toFixed(2), offset: +offset.toFixed(2) });
    }

    function runVoices() {
        if (!soundWanted || !audio || audio.ctx.state !== 'running' || voice) { return; }
        var names = Object.keys(CREATURES);
        for (var i = 0; i < names.length; i++) {
            var name = names[i];
            var layer = byName[name];
            var buffer = audio.buffers[name];
            if (!layer || !layer.active || !layer.drawn || !buffer) { continue; }
            var start = mod(layer.def.offset + layer.def.soundAt, CYCLE);
            var until = mod(start - clock, CYCLE);
            var into = mod(clock - start, CYCLE);
            // Only speak if this creature's picture is really at the right moment
            var inSync = Math.abs(layer.video.currentTime - clipTime(layer, clock)) < 0.3 && !layer.video.paused;
            if (!inSync) { continue; }
            if (until <= 0.12) {
                startVoice(name, until, 0);
                return;
            }
            // Coming back from a pause part-way through: pick the sound up at the matching point
            if (into > 0.12 && into < buffer.duration - 0.8) {
                startVoice(name, 0, into);
                return;
            }
        }
    }

    function updateToggle() {
        if (!toggle) { return; }
        toggle.setAttribute('aria-pressed', soundWanted ? 'true' : 'false');
        var text = toggle.querySelector('.sound-toggle-text');
        if (text) { text.textContent = soundWanted ? 'Sound on' : 'Sound off'; }
    }

    function setSound(on) {
        soundWanted = on;
        updateToggle();
        if (on) {
            var a = ensureAudio();
            if (!a) {
                soundWanted = false;
                updateToggle();
                return;
            }
            a.master.gain.value = pageGain;
            if (a.ctx.resume) { a.ctx.resume(); }
            // A press on the button also unblocks video on phones and in Low Power Mode
            wantedLayers().forEach(function (l) {
                if (l.failed || !ensureVideo(l)) { return; }
                l.active = true;
                l.blocked = false;
                if (running && l.video.paused) {
                    l.video.currentTime = clipTime(l, clock);
                    l.video.play().catch(function () { l.blocked = true; });
                }
            });
            if (!running) { play(); }
        } else {
            stopVoice(0.2);
            if (audio && audio.ctx.suspend) {
                setTimeout(function () {
                    if (!soundWanted && audio) { audio.ctx.suspend(); }
                }, 300);
            }
            if (phoneQuery.matches) {
                layers.forEach(function (l) {
                    if (l.name !== 'manticore' && l.video) {
                        l.video.pause();
                        l.active = false;
                        l.el.classList.remove('is-live');
                        l.drawn = false;
                    }
                });
            }
        }
    }

    /* ---------- Start up ---------- */
    Array.prototype.forEach.call(stage.querySelectorAll('[data-creature]'), createLayer);

    function webglWorks() {
        try {
            var test = document.createElement('canvas');
            return !!(test.getContext('webgl') || test.getContext('experimental-webgl'));
        } catch (err) {
            return false;
        }
    }

    if (toggle) {
        if (!motionAllowed() || !webglWorks()) {
            toggle.hidden = true;
        } else {
            toggle.hidden = false;
            toggle.addEventListener('click', function () { setSound(!soundWanted); });
        }
        updateToggle();
    }

    function boot() {
        if (started || !motionAllowed()) { return; }
        started = true;
        new IntersectionObserver(function (entries) {
            inView = entries[0].isIntersecting;
            if (inView) {
                if (audio && soundWanted && audio.ctx.resume) { audio.ctx.resume(); }
                play();
            } else {
                pause();
            }
        }, { threshold: 0.02 }).observe(stage);
        play();
    }

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            pause();
            if (audio && audio.ctx.suspend) { audio.ctx.suspend(); }
        } else if (started) {
            if (audio && soundWanted && audio.ctx.resume) { audio.ctx.resume(); }
            play();
        }
    });

    motionQuery.addEventListener && motionQuery.addEventListener('change', function () {
        if (motionQuery.matches) {
            pause();
            layers.forEach(function (l) { l.el.classList.remove('is-live'); l.drawn = false; });
            if (toggle) { toggle.hidden = true; }
            soundWanted = false;
            updateToggle();
        }
    });

    /* ---------- Fitting a creature into clear space ----------
       Some creatures sweep their wings across nearly the whole video frame during the cycle, so the frame itself
       must stay clear of the copy. Text widths depend on fonts and screen size, so the clear space is measured
       here and the creature is given the largest box that touches no text. Without JavaScript the CSS
       position stays in place. */
    // Share of each frame the creature reaches at any point in its cycle (measured from the videos)
    var REACH = { rex: [0.106, 0.084, 0.863, 0.896], dragon: [0.05, 0.007, 0.998, 0.993], manticore: [0, 0, 1, 1] };
    // The same reach in detail: for each of 36 rows of the frame, the first and last of 64 columns the creature
    // touches at any moment of the cycle (measured from every frame's alpha). Lets creatures sit close without touching.
    var SPANS = {
        rex: [null, null, null, [20, 22], [18, 24], [18, 24], [14, 25], [11, 25], [10, 27], [8, 33], [7, 34], [7, 36], [6, 38], [6, 51], [7, 54], [7, 55], [7, 55], [8, 45], [9, 40], [11, 36], [18, 36], [18, 37], [19, 37], [22, 37], [24, 37], [25, 38], [25, 37], [24, 38], [23, 38], [21, 38], [20, 39], [19, 39], [21, 25], null, null, null],
        dragon: [[46, 57], [32, 59], [31, 60], [29, 61], [28, 61], [27, 63], [26, 63], [5, 63], [3, 63], [3, 63], [3, 63], [4, 63], [5, 63], [6, 63], [7, 63], [6, 63], [5, 63], [4, 63], [3, 63], [3, 63], [3, 63], [3, 63], [3, 63], [3, 63], [23, 62], [24, 62], [24, 61], [24, 61], [25, 60], [25, 59], [25, 59], [26, 59], [27, 56], [28, 55], [29, 53], [47, 52]]
    };

    // Plain text with no box of its own is measured by its words, not by the full width of its container
    function isBareText(el) {
        if (/^(H1|H2|P)$/.test(el.tagName)) { return true; }
        for (var i = 0; i < el.children.length; i++) { if (el.children[i].tagName !== 'BR') { return false; } }
        var cs = getComputedStyle(el);
        return cs.backgroundColor === 'rgba(0, 0, 0, 0)' && cs.backgroundImage === 'none' && !parseFloat(cs.borderTopWidth) && !parseFloat(cs.borderLeftWidth);
    }

    function boxesOf(selector, origin, margin) {
        var out = [];
        if (!selector) { return out; }
        Array.prototype.forEach.call(document.querySelectorAll(selector), function (el) {
            var rects;
            if (isBareText(el)) {
                var range = document.createRange();
                range.selectNodeContents(el);
                rects = range.getClientRects();
            } else {
                rects = [el.getBoundingClientRect()];
            }
            // The display font's line boxes carry empty space above and below its capitals (measured at 19% and 26%
            // of the box), so headings are measured by their letters, slightly generously.
            var ink = el.tagName === 'H1' ? [0.17, 0.24] : [0, 0];
            Array.prototype.forEach.call(rects, function (r) {
                if (r.width && r.height) {
                    out.push([r.left - origin.left - margin, r.top + r.height * ink[0] - origin.top - margin, r.right - origin.left + margin, r.bottom - r.height * ink[1] - origin.top + margin]);
                }
            });
        });
        return out;
    }

    var fitFinal = false;
    function fitLayers() {
        var origin = stage.getBoundingClientRect();
        var nav = document.querySelector('nav');
        // Layout height, so the nav's slide-in animation cannot skew the measurement
        var navBottom = nav ? nav.offsetHeight - (origin.top + window.scrollY) : 0;
        var board = document.querySelector('.maps');
        layers.forEach(function (l) {
            var el = l.el;
            var side = el.getAttribute('data-fit');
            if (!side) { return; }
            var media = el.getAttribute('data-fit-media');
            if (media && !window.matchMedia(media).matches) {
                el.style.left = el.style.right = el.style.top = el.style.bottom = el.style.width = '';
                el.classList.remove('is-fitting');
                return;
            }
            var avoid = boxesOf(el.getAttribute('data-fit-avoid'), origin, 16);
            // Other creatures, written "rex" to keep clear of it, or "dragon:0.05" to allow overlap up to that share of
            // this creature's outline, since a creature further back passing behind another reads as depth
            var others = [];
            (el.getAttribute('data-fit-avoid-creatures') || '').split(/\s+/).forEach(function (token) {
                var name = token.split(':')[0], share = parseFloat(token.split(':')[1]) || 0;
                var other = byName[name];
                if (!other) { return; }
                var r = other.el.getBoundingClientRect(), f = REACH[name], rows = SPANS[name];
                if (!r.width) { return; }
                var gap = share ? 0 : 10, list = [];
                if (!rows) {
                    list.push([r.left - origin.left + r.width * f[0] - gap, r.top - origin.top + r.height * f[1] - gap, r.left - origin.left + r.width * f[2] + gap, r.top - origin.top + r.height * f[3] + gap]);
                } else {
                    rows.forEach(function (s, i) {
                        if (!s) { return; }
                        list.push([r.left - origin.left + r.width * s[0] / 64 - gap, r.top - origin.top + r.height * i / 36 - gap, r.left - origin.left + r.width * (s[1] + 1) / 64 + gap, r.top - origin.top + r.height * (i + 1) / 36 + gap]);
                    });
                }
                others.push({ rects: list, share: share });
            });
            var W = origin.width, H = window.innerHeight, pad = 8;
            // Share of the frame allowed past the screen edge on the creature's own side. Only the outermost wing
            // tips reach there, in a few frames of the cycle, so they briefly pass the edge as in a film shot.
            var bleed = parseFloat(el.getAttribute('data-fit-bleed')) || 0;
            // Wing tips at the top of the frame may rise this far behind the translucent nav
            var under = parseFloat(el.getAttribute('data-fit-under-nav')) || 0;
            // The page's pointer parallax can lift a layer by up to 0.14 x its depth (data-depth), so keep that much
            // more room below the nav. Layers without a depth (the homepage creatures) are unaffected.
            var lift = (parseFloat(el.getAttribute('data-depth')) || 0) * 0.14;
            var top = navBottom + 6 + lift;
            var bottom = origin.height - 8;
            if (board) { bottom = Math.min(bottom, board.getBoundingClientRect().top - origin.top - 8); }
            // Largest size, as shares of the screen's width and height
            var cap = (el.getAttribute('data-fit-max') || '').split(/\s+/).map(parseFloat);
            var maxW = cap[0] ? Math.min(W * cap[0], cap[1] ? H * cap[1] : Infinity) : Math.min(W * (side === 'left' ? 0.5 : 0.62), 980);
            var heading = document.querySelector('.hero h1');
            var hr = heading ? heading.getBoundingClientRect() : origin;
            var pref = el.getAttribute('data-fit-pref') || (side === 'left' ? 'heading' : 'top');
            var prefY = pref === 'heading' ? (hr.top + hr.bottom) / 2 - origin.top : pref === 'bottom' ? bottom : top;
            // Where the frame's middle may sit, as shares of the stage height, so each creature keeps its part of the scene
            var band = (el.getAttribute('data-fit-band') || '0 1').split(/\s+/).map(parseFloat);
            var bandTop = origin.height * band[0], bandBottom = origin.height * band[1];
            // Creatures with a measured outline are fitted by that outline; the rest by their whole frame
            var rows = el.hasAttribute('data-fit-shape') ? SPANS[l.name] : null;
            var mirror = el.classList.contains('creature--mirror');
            function parts(x0, y0, w) {
                var h = w * 0.5625;
                if (!rows) { return [[x0, y0, x0 + w, y0 + h]]; }
                var out = [];
                rows.forEach(function (s, i) {
                    if (!s) { return; }
                    var c0 = s[0], c1 = s[1] + 1;
                    if (mirror) { c0 = 64 - s[1] - 1; c1 = 64 - s[0]; }
                    out.push([x0 + w * c0 / 64, y0 + h * i / 36, x0 + w * c1 / 64, y0 + h * (i + 1) / 36]);
                });
                return out;
            }
            function hit(p, list) {
                var a = 0;
                for (var i = 0; i < list.length; i++) {
                    var b = list[i];
                    var ow = Math.min(p[2], b[2]) - Math.max(p[0], b[0]), oh = Math.min(p[3], b[3]) - Math.max(p[1], b[1]);
                    if (ow > 0 && oh > 0) { a += ow * oh; }
                }
                return a;
            }
            // Overlap with the copy in px², plus any creature overlap beyond the allowed share; -1 when the frame's
            // middle leaves its band or the outline leaves the space allowed
            function overlap(x0, y0, w, stopAtFirst) {
                var cy = y0 + w * 0.28125;
                if (cy < bandTop || cy > bandBottom) { return -1; }
                var ps = parts(x0, y0, w), sum = 0, own = 0, crea = others.map(function () { return 0; });
                for (var j = 0; j < ps.length; j++) {
                    var p = ps[j];
                    if (p[3] > bottom || p[1] < top - under) { return -1; }
                    sum += hit(p, avoid);
                    if (stopAtFirst && sum) { return sum; }
                    own += (p[2] - p[0]) * (p[3] - p[1]);
                    for (var k = 0; k < others.length; k++) { crea[k] += hit(p, others[k].rects); }
                }
                for (var n = 0; n < others.length; n++) { sum += Math.max(0, crea[n] - others[n].share * own); }
                return sum;
            }
            function clear(x0, y0, w) { return overlap(x0, y0, w, true) === 0; }
            function xAt(w) { return side === 'left' ? pad - w * bleed : W - pad - w * (1 - bleed); }
            var yFrom = rows ? top - under - maxW * 0.5625 * 0.3 : top;
            var best = null;
            for (var y = yFrom; y < bottom - 90; y += 4) {
                var lo = 0, hi = maxW;
                while (hi - lo > 2) {
                    var mid = (lo + hi) / 2;
                    if (clear(xAt(mid), y, mid)) { lo = mid; } else { hi = mid; }
                }
                var cy = y + lo * 0.28;
                var score = lo - Math.abs(cy - prefY) * 0.08;
                if (lo > 150 && (!best || score > best.score)) { best = { w: lo, y: y, score: score }; }
            }
            // Not smaller than the size set in the stylesheet (the approved size) where that size still fits with,
            // at most, a brush of the safety margin around the copy. Otherwise the largest clear size stands, as
            // keeping text readable comes first.
            if (el.hasAttribute('data-fit-floor')) {
                var wasHidden = el.classList.contains('is-fitting'), saved = el.style.width;
                el.style.width = '';
                if (wasHidden) { el.classList.remove('is-fitting'); }
                var floorW = el.getBoundingClientRect().width;
                if (wasHidden) { el.classList.add('is-fitting'); }
                el.style.width = saved;
                if (floorW && (!best || best.w < floorW)) {
                    var least = null;
                    for (var fy = yFrom; fy < bottom; fy += 4) {
                        var o = overlap(xAt(floorW), fy, floorW, false);
                        if (o < 0 || o > floorW * 0.25) { continue; }
                        var fs = Math.round(o / 400) * 400 + Math.abs(fy + floorW * 0.28 - prefY) * 0.5;
                        if (!least || fs < least.score) { least = { w: floorW, y: fy, score: fs }; }
                    }
                    if (least) { best = least; }
                }
            }
            if (fitFinal && el.classList.contains('is-fitting')) { el.classList.remove('is-fitting'); el.classList.add('fit-in'); }
            if (!best) { return; }
            var w = Math.floor(best.w), off = Math.round(pad - w * bleed) + 'px';
            el.style.width = w + 'px';
            el.style.top = Math.round(best.y) + 'px';
            el.style.bottom = 'auto';
            if (side === 'left') {
                el.style.left = off;
                el.style.right = 'auto';
            } else {
                el.style.right = off;
                el.style.left = 'auto';
            }
        });
    }

    var fitTimer = 0;
    function scheduleFit() {
        clearTimeout(fitTimer);
        fitTimer = setTimeout(fitLayers, 120);
    }

    // The copy slides into place when the page opens, so the final measurement waits for that to finish.
    // Until then a fitted creature stays hidden, then fades in at its place.
    function afterEntrance() {
        var content = document.querySelector('.hero-content') || stage;
        var waits = (document.getAnimations ? document.getAnimations() : []).filter(function (a) {
            var t = a.effect && a.effect.target;
            var timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
            return t && (content.contains(t) || t.tagName === 'NAV') && timing && isFinite(timing.endTime);
        }).map(function (a) { return a.finished.catch(function () {}); });
        if (document.fonts && document.fonts.ready) { waits.push(document.fonts.ready); }
        return Promise.all(waits);
    }

    layers.forEach(function (l) {
        var media = l.el.getAttribute('data-fit-media');
        if (l.el.getAttribute('data-fit') && (!media || window.matchMedia(media).matches)) { l.el.classList.add('is-fitting'); }
    });
    fitLayers();
    afterEntrance().then(function () { fitFinal = true; fitLayers(); }, function () { fitFinal = true; fitLayers(); });
    // Safety net: never leave a creature hidden
    setTimeout(function () { layers.forEach(function (l) { if (l.el.classList.contains('is-fitting')) { l.el.classList.remove('is-fitting'); l.el.classList.add('fit-in'); } }); }, 4000);
    window.addEventListener('resize', scheduleFit);
    window.addEventListener('load', function () { afterEntrance().then(fitLayers, fitLayers); });

    // Let the page and its text paint first, then begin
    if (document.readyState === 'complete') {
        setTimeout(boot, 300);
    } else {
        window.addEventListener('load', function () { setTimeout(boot, 300); });
    }

    // Hooks for local testing only; never present on the public site
    if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) { return; }
    window.BraveCreatures = {
        state: function () {
            return {
                clock: +clock.toFixed(2), running: running, inView: inView, sound: soundWanted, voice: voice && voice.name,
                audioState: audio && audio.ctx.state,
                layers: layers.map(function (l) {
                    return { name: l.name, active: l.active, live: l.el.classList.contains('is-live'), failed: l.failed, time: l.video ? +l.video.currentTime.toFixed(2) : null, paused: l.video ? l.video.paused : null, src: l.video ? l.video.currentSrc.split('/').pop() : null, want: +clipTime(l, clock).toFixed(2) };
                })
            };
        },
        log: log,
        // Test-only: hold the page at one moment of the cycle, for frame-accurate previews
        hold: function (t) {
            running = false;
            if (frame) { cancelAnimationFrame(frame); frame = 0; }
            clock = mod(t, CYCLE);
            return Promise.all(layers.filter(function (l) { return l.video; }).map(function (l) {
                return new Promise(function (ok) {
                    l.video.pause();
                    var done = function () { draw(l); ok(); };
                    if (Math.abs(l.video.currentTime - clipTime(l, clock)) < 0.001 && l.video.readyState >= 2) { done(); return; }
                    l.video.addEventListener('seeked', done, { once: true });
                    l.video.currentTime = clipTime(l, clock);
                });
            }));
        }
    };
})();
