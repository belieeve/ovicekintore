(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const W = canvas.width;
  const H = canvas.height;
  // Global controls and screens
  const urlInput = document.getElementById('urlInput');
  const fileInput = document.getElementById('fileInput');
  const pauseBtn = document.getElementById('pauseBtn');
  const restartBtn = document.getElementById('restartBtn');
  const startBtn = document.getElementById('startBtn');
  const statusEl = document.getElementById('status');
  const scoreEl = document.getElementById('score');
  const comboEl = document.getElementById('combo');
  const maxComboEl = document.getElementById('maxCombo');
  const accEl = document.getElementById('acc');
  const bpmEl = document.getElementById('bpm');
  const audioEl = document.getElementById('player');
  const keybarEl = document.getElementById('keybar');
  const useAssetsBtn = document.getElementById('useAssetsBtn');
  const useAssetsBtn2 = document.getElementById('useAssetsBtn2');
  const analyzeBtn = document.getElementById('analyzeBtn');
  const screenStart = document.getElementById('screen-start');
  const screenSong = document.getElementById('screen-song');
  const screenLevel = document.getElementById('screen-level');
  const screenGame = document.getElementById('screen-game');
  const btnGoSong = document.getElementById('btnGoSong');
  const btnToLevel = document.getElementById('btnToLevel');
  const btnBackStart = document.getElementById('btnBackStart');
  const btnBackSong = document.getElementById('btnBackSong');
  const btnBackLevel = document.getElementById('btnBackLevel');

  // Canvas scaling for HiDPI
  function resizeCanvas() {
    const width = W;
    const height = H;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resizeCanvas();

  // Game state
  const LANES = 4;
  const KEYS = ['KeyD', 'KeyF', 'KeyJ', 'KeyK'];
  // Gym-themed lane colors (plate colors): green, blue, yellow, red
  const LANE_COLORS = ['#66bb6a', '#42a5f5', '#fdd835', '#ef5350'];
  const HITLINE_Y = H - 140;
  let NOTE_LEAD = 2.2; // seconds from spawn to hitline (varies by level)
  const TRAVEL = H - 200; // pixels traveled during NOTE_SPEED_LEAD
  const HIT_WINDOWS = {
    perfect: 0.05,
    great: 0.09,
    good: 0.12,
  };

  let chart = [];
  let started = false;
  let playing = false;
  let paused = false;
  let analyzed = false;
  let objectUrl = null; // for local file
  let bpmEstimate = null;
  let autoStartNext = false; // deprecated with explicit start button, kept for compatibility
  let difficulty = 'normal';

  const scoreState = {
    score: 0,
    combo: 0,
    maxCombo: 0,
    judgments: { perfect: 0, great: 0, good: 0, miss: 0 },
  };

  function resetScore() {
    scoreState.score = 0;
    scoreState.combo = 0;
    scoreState.maxCombo = 0;
    scoreState.judgments = { perfect: 0, great: 0, good: 0, miss: 0 };
    updateHUD();
  }

  function updateHUD() {
    scoreEl.textContent = scoreState.score.toString();
    comboEl.textContent = scoreState.combo.toString();
    maxComboEl.textContent = scoreState.maxCombo.toString();
    const total = Object.values(scoreState.judgments).reduce((a, b) => a + b, 0);
    const acc = total === 0 ? 0 : (scoreState.judgments.perfect * 1.0 + scoreState.judgments.great * 0.7 + scoreState.judgments.good * 0.4) / total * 100;
    accEl.textContent = acc.toFixed(2) + '%';
    bpmEl.textContent = bpmEstimate ? Math.round(bpmEstimate).toString() : '-';
  }

  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  // Simple onset detection + BPM estimation
  async function fetchArrayBufferFromSource() {
    const url = urlInput.value.trim();
    const file = fileInput.files && fileInput.files[0];
    if (!url && !file) throw new Error('URLまたはファイルを指定してください');

    if (file) {
      return await file.arrayBuffer();
    }
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error('MP3の取得に失敗しました');
    return await res.arrayBuffer();
  }

  function downmixToMono(buffer) {
    const ch = buffer.numberOfChannels;
    const len = buffer.length;
    const sr = buffer.sampleRate;
    const out = new Float32Array(len);
    for (let c = 0; c < ch; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < len; i++) out[i] += data[i] / ch;
    }
    return { data: out, sampleRate: sr };
  }

  function detectOnsetsAndBPM(mono, sr) {
    const hop = 1024;
    const win = 2048;
    const nFrames = Math.floor((mono.length - win) / hop);
    const energies = new Float32Array(nFrames);

    // Short-time energy
    for (let i = 0; i < nFrames; i++) {
      let sum = 0;
      const base = i * hop;
      for (let j = 0; j < win; j++) {
        const s = mono[base + j] || 0;
        sum += s * s;
      }
      energies[i] = sum / win;
    }

    // High-pass on energy to reduce baseline (simple diff + clamp)
    const diff = new Float32Array(nFrames);
    diff[0] = 0;
    for (let i = 1; i < nFrames; i++) {
      const d = energies[i] - energies[i - 1];
      diff[i] = d > 0 ? d : 0;
    }

    // Smooth with moving average
    const smoothed = new Float32Array(nFrames);
    const m = 4;
    let acc = 0;
    for (let i = 0; i < nFrames; i++) {
      acc += diff[i];
      if (i >= m) acc -= diff[i - m];
      smoothed[i] = acc / Math.min(i + 1, m);
    }

    // Adaptive threshold
    const mean = smoothed.reduce((a, b) => a + b, 0) / nFrames;
    let sq = 0;
    for (let i = 0; i < nFrames; i++) sq += (smoothed[i] - mean) ** 2;
    const std = Math.sqrt(sq / nFrames) || 1e-6;
    const threshold = mean + 1.0 * std;

    // Peak picking (local maxima above threshold)
    const peaks = [];
    for (let i = 2; i < nFrames - 2; i++) {
      const v = smoothed[i];
      if (v > threshold && v > smoothed[i - 1] && v > smoothed[i + 1]) {
        const t = (i * hop + win / 2) / sr;
        peaks.push(t);
      }
    }

    // Estimate BPM via interval histogram
    let bpm = null;
    if (peaks.length >= 4) {
      const intervals = [];
      for (let i = 1; i < peaks.length; i++) {
        const dt = peaks[i] - peaks[i - 1];
        if (dt > 0.2 && dt < 1.5) intervals.push(dt); // likely beat spacings
      }
      if (intervals.length) {
        const hist = new Map();
        for (const dt of intervals) {
          let cands = [dt, dt * 2, dt / 2]; // account for half/double tempo
          for (const cand of cands) {
            const b = Math.round(60 / cand);
            if (b >= 60 && b <= 200) {
              hist.set(b, (hist.get(b) || 0) + 1);
            }
          }
        }
        let bestBpm = 120, bestCount = -1;
        for (const [b, count] of hist.entries()) {
          if (count > bestCount) { bestCount = count; bestBpm = b; }
        }
        bpm = bestBpm;
      }
    }

    return { peaks, bpm };
  }

  function buildChartFromOnsets(peaks, bpm) {
    if (!peaks || peaks.length === 0) return [];
    // Enforce min spacing
    const MIN_SPACING = 0.12; // seconds
    const filtered = [];
    let last = -999;
    for (const t of peaks) {
      if (t - last >= MIN_SPACING) { filtered.push(t); last = t; }
    }

    // Optional quantization to beat grid if BPM exists
    let times = filtered;
    if (bpm) {
      const spb = 60 / bpm; // seconds per beat
      // Assume the first strong onset is near grid; refine by testing small offsets
      const t0 = filtered[0];
      let bestOffset = 0, bestScore = Infinity;
      for (let offs = -0.2; offs <= 0.2; offs += 0.01) {
        let err = 0;
        for (const t of filtered.slice(0, Math.min(50, filtered.length))) {
          const q = Math.round((t - (t0 + offs)) / (spb / 2)); // 1/2 beat grid
          const snapped = (t0 + offs) + q * (spb / 2);
          err += Math.abs(t - snapped);
        }
        if (err < bestScore) { bestScore = err; bestOffset = offs; }
      }
      times = filtered.map(t => {
        const q = Math.round((t - (t0 + bestOffset)) / (spb / 2));
        return (t0 + bestOffset) + q * (spb / 2);
      });
      // Clean doubles after quantization
      times.sort((a, b) => a - b);
      const cleaned = [];
      let lastT = -999;
      for (const t of times) {
        if (t - lastT >= MIN_SPACING) { cleaned.push(t); lastT = t; }
      }
      times = cleaned;
    }

    // Assign lanes (round-robin with small randomness)
    let notes = [];
    let lane = 0;
    for (const t of times) {
      lane = (lane + (Math.random() < 0.2 ? 2 : 1)) % LANES;
      notes.push({ time: t, lane, hit: false, judged: false, result: null });
    }
    // Apply difficulty density
    const keep = difficulty === 'easy' ? 0.5 : difficulty === 'hard' ? 1.0 : 0.75;
    if (keep < 0.999) {
      const filtered = [];
      for (let i = 0; i < notes.length; i++) {
        if (Math.random() <= keep) filtered.push(notes[i]);
      }
      notes = filtered;
    }
    return notes;
  }

  async function analyze() {
    try {
      setStatus('音源を取得中…');
      const buf = await fetchArrayBufferFromSource();
      setStatus('デコード中…');
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const audioBuffer = await ac.decodeAudioData(buf.slice(0));
      const { data, sampleRate } = downmixToMono(audioBuffer);
      setStatus('譜面を自動生成中…');
      const { peaks, bpm } = detectOnsetsAndBPM(data, sampleRate);
      bpmEstimate = bpm || null;
      chart = buildChartFromOnsets(peaks, bpmEstimate);
      analyzed = true;
      updateHUD();
      setStatus(`解析完了: ノーツ ${chart.length} 個${bpmEstimate ? ` / 推定BPM ${Math.round(bpmEstimate)}` : ''}`);

      // Prepare audio element source
      const url = urlInput.value.trim();
      const file = fileInput.files && fileInput.files[0];
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
      if (file) {
        objectUrl = URL.createObjectURL(file);
        audioEl.src = objectUrl;
      } else if (url) {
        audioEl.src = url;
      }

      pauseBtn.disabled = true;
      restartBtn.disabled = true;
      // Enable start button if we're on game screen
      if (startBtn) startBtn.disabled = false;
      // If an older flow requested auto start, respect it
      if (autoStartNext) {
        autoStartNext = false;
        showScreen('game');
        if (startBtn) {
          // require explicit press now; keep enabled
          startBtn.disabled = false;
        } else {
          startGame();
        }
      }
    } catch (e) {
      console.error(e);
      setStatus('解析に失敗しました: ' + (e?.message || e));
    }
  }

  // Rendering
  function drawPlayfield(t) {
    ctx.clearRect(0, 0, W, H);

    // Lanes
    const laneWidth = W / LANES;
    for (let i = 0; i < LANES; i++) {
      ctx.fillStyle = '#12141b';
      ctx.fillRect(i * laneWidth + 2, 0, laneWidth - 4, H);
      ctx.strokeStyle = '#24273a';
      ctx.strokeRect(i * laneWidth + 0.5, 0.5, laneWidth - 1, H - 1);
    }

    // Hit line band with hazard stripes (gym vibe)
    const bandH = 26;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, HITLINE_Y - bandH, W, bandH * 2);
    ctx.clip();
    ctx.fillStyle = '#11141c';
    ctx.fillRect(0, HITLINE_Y - bandH, W, bandH * 2);
    // diagonal stripes
    for (let x = -W; x < W * 2; x += 28) {
      ctx.fillStyle = 'rgba(255, 160, 0, 0.22)';
      ctx.beginPath();
      ctx.moveTo(x, HITLINE_Y - bandH);
      ctx.lineTo(x + 14, HITLINE_Y - bandH);
      ctx.lineTo(x + 14 + bandH * 2, HITLINE_Y + bandH);
      ctx.lineTo(x + bandH * 2, HITLINE_Y + bandH);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    // Center hit line + soft glow
    ctx.save();
    ctx.strokeStyle = '#ffffff66';
    ctx.lineWidth = 2;
    ctx.shadowBlur = 12;
    ctx.shadowColor = '#fff';
    ctx.beginPath();
    ctx.moveTo(0, HITLINE_Y);
    ctx.lineTo(W, HITLINE_Y);
    ctx.stroke();
    ctx.restore();

    // Notes
    for (const note of chart) {
      const dt = note.time - t;
      if (note.judged && note.result === 'miss') continue; // hide late misses
      if (dt < -0.5 && !note.hit) continue; // long gone
      const laneX = (note.lane + 0.5) * laneWidth;
      const y = HITLINE_Y - (dt / NOTE_LEAD) * TRAVEL;
      // Only draw around screen
      if (y < -40 || y > H + 40) continue;
      const w = laneWidth * 0.7;
      const h = 16;
      // Glow layer
      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = LANE_COLORS[note.lane];
      ctx.shadowBlur = 16;
      ctx.shadowColor = LANE_COLORS[note.lane];
      ctx.fillRect(laneX - w / 2, y - h / 2, w, h);
      ctx.restore();
      // Core layer (crisper)
      ctx.fillStyle = LANE_COLORS[note.lane];
      ctx.fillRect(laneX - w / 2, y - h / 2, w, h);
    }
  }

  function judgeKey(lane, t) {
    // find nearest unhit note in this lane within good window
    let best = null;
    let bestAbs = Infinity;
    for (const note of chart) {
      if (note.lane !== lane || note.hit || note.judged) continue;
      const delta = t - note.time;
      const absd = Math.abs(delta);
      if (absd < bestAbs) { bestAbs = absd; best = note; }
    }
    if (!best || bestAbs > HIT_WINDOWS.good) return missTap();

    let res = 'good';
    if (bestAbs <= HIT_WINDOWS.perfect) res = 'perfect';
    else if (bestAbs <= HIT_WINDOWS.great) res = 'great';

    best.hit = true;
    best.judged = true;
    best.result = res;
    applyJudgment(res);
  }

  function missTap() {
    applyJudgment('miss');
  }

  function applyJudgment(res) {
    const gain = { perfect: 1000, great: 600, good: 300, miss: 0 }[res];
    scoreState.judgments[res]++;
    if (res === 'miss') {
      scoreState.combo = 0;
    } else {
      scoreState.combo += 1;
      scoreState.maxCombo = Math.max(scoreState.maxCombo, scoreState.combo);
      scoreState.score += gain + Math.floor(scoreState.combo * 1.5);
    }
    updateHUD();
  }

  function passiveMisses(t) {
    let any = false;
    for (const note of chart) {
      if ((note.hit || note.judged) || note.time > t + HIT_WINDOWS.good) continue;
      if (t - note.time > HIT_WINDOWS.good) {
        note.judged = true;
        note.result = 'miss';
        scoreState.judgments.miss++;
        scoreState.combo = 0;
        any = true;
      }
    }
    if (any) updateHUD();
  }

  function gameLoop() {
    if (!playing) return;
    const t = audioEl.currentTime || 0;
    passiveMisses(t);
    drawPlayfield(t);

    if (audioEl.ended) {
      playing = false;
      pauseBtn.disabled = true;
      restartBtn.disabled = false;
      setStatus('終了しました。リスタートできます');
      return;
    }
    requestAnimationFrame(gameLoop);
  }

  function startGame() {
    if (!analyzed || !audioEl.src) {
      setStatus('先に「譜面を自動生成」を行ってください');
      return;
    }
    // Reset note states
    for (const n of chart) { n.hit = false; n.judged = false; n.result = null; }
    resetScore();
    audioEl.currentTime = 0;
    audioEl.play().then(() => {
      started = true;
      playing = true;
      paused = false;
      pauseBtn.disabled = false;
      restartBtn.disabled = false;
      if (startBtn) startBtn.disabled = true;
      setStatus('プレイ中…');
      requestAnimationFrame(gameLoop);
    }).catch(err => {
      setStatus('再生に失敗: ' + err?.message);
    });
  }

  function togglePause() {
    if (!started) return;
    if (!paused) {
      audioEl.pause();
      paused = true;
      playing = false;
      setStatus('一時停止中');
    } else {
      audioEl.play().then(() => {
        paused = false;
        playing = true;
        setStatus('再開');
        requestAnimationFrame(gameLoop);
      });
    }
  }

  function restart() {
    if (!started) return;
    audioEl.pause();
    startGame();
  }

  // Input handling
  window.addEventListener('keydown', (e) => {
    const lane = KEYS.indexOf(e.code);
    if (lane !== -1) {
      if (e.repeat) return; // 長押しのリピート入力は無視
      e.preventDefault();
      // 視覚: キーを点灯
      const btn = keybarEl?.querySelector(`.key[data-lane="${lane}"]`);
      if (btn) btn.classList.add('active');
      if (!playing) return;
      const t = audioEl.currentTime || 0;
      judgeKey(lane, t);
    }
  }, { passive: false });

  window.addEventListener('keyup', (e) => {
    const lane = KEYS.indexOf(e.code);
    if (lane !== -1) {
      const btn = keybarEl?.querySelector(`.key[data-lane=\"${lane}\"]`);
      if (btn) btn.classList.remove('active');
    }
  });

  // Screen navigation helpers
  function showScreen(name) {
    const map = { start: screenStart, song: screenSong, level: screenLevel, game: screenGame };
    for (const [k, el] of Object.entries(map)) {
      if (!el) continue;
      el.classList.toggle('active', k === name);
    }
    if (name === 'game') positionKeybar();
  }

  if (btnGoSong) btnGoSong.addEventListener('click', () => showScreen('song'));
  if (btnBackStart) btnBackStart.addEventListener('click', () => showScreen('start'));
  if (btnBackSong) btnBackSong.addEventListener('click', () => showScreen('song'));
  if (btnBackLevel) btnBackLevel.addEventListener('click', () => showScreen('level'));

  if (btnToLevel) {
    btnToLevel.addEventListener('click', () => {
      const hasUrl = urlInput && urlInput.value.trim().length > 0;
      const hasFile = fileInput && fileInput.files && fileInput.files[0];
      if (!hasUrl && !hasFile) { setStatus('曲を選択してください（assetsボタン・URL・ファイル）'); return; }
      showScreen('level');
    });
  }
  pauseBtn.addEventListener('click', togglePause);
  restartBtn.addEventListener('click', restart);
  if (startBtn) startBtn.addEventListener('click', startGame);
  if (analyzeBtn) {
    analyzeBtn.addEventListener('click', () => {
      const hasUrl = urlInput && urlInput.value.trim().length > 0;
      const hasFile = fileInput && fileInput.files && fileInput.files[0];
      if (!hasUrl && !hasFile) { setStatus('曲を選択してください（assetsボタン・URL・ファイル）'); return; }
      analyze();
    });
  }
  if (useAssetsBtn) {
    useAssetsBtn.addEventListener('click', () => {
      urlInput.value = 'assets/ovicekintoresong1.mp3';
      setStatus('『画面の向こう、汗をかこう！』を選択しました');
    });
  }
  if (useAssetsBtn2) {
    useAssetsBtn2.addEventListener('click', () => {
      urlInput.value = 'assets/ovicekintoresong2.mp3';
      setStatus('『oviceで会えた奇跡』を選択しました');
    });
  }

  // Level selection → analyze → auto-start
  document.querySelectorAll('.level').forEach(btn => {
    btn.addEventListener('click', () => {
      const lvl = btn.getAttribute('data-level') || 'normal';
      difficulty = lvl;
      NOTE_LEAD = (lvl === 'easy') ? 2.6 : (lvl === 'hard') ? 1.9 : 2.2;
      // New flow: require explicit start
      if (!analyzed) {
        showScreen('song');
        setStatus('「譜面を自動生成」を押してからスタートしてください');
      } else {
        showScreen('game');
        if (startBtn) startBtn.disabled = false; // ready to press
      }
    });
  });

  // Click/Touch on on-screen keys
  if (keybarEl) {
    const press = (lane) => {
      const btn = keybarEl.querySelector(`.key[data-lane=\"${lane}\"]`);
      if (btn) btn.classList.add('active');
      if (playing) {
        const t = audioEl.currentTime || 0;
        judgeKey(lane, t);
      }
      // 小さな遅延で解除（タップ視覚）
      setTimeout(() => { if (btn) btn.classList.remove('active'); }, 80);
    };
    keybarEl.addEventListener('pointerdown', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const laneStr = target.getAttribute('data-lane');
      if (laneStr == null) return;
      e.preventDefault();
      press(parseInt(laneStr, 10));
    });
  }
  // Position on-screen keys over the hitline
  function positionKeybar() {
    if (!keybarEl) return;
    const left = canvas.offsetLeft;
    const kbH = keybarEl.offsetHeight || 96;
    const top = canvas.offsetTop + HITLINE_Y - (kbH / 2);
    keybarEl.style.left = left + 'px';
    keybarEl.style.top = top + 'px';
    keybarEl.style.width = canvas.clientWidth + 'px';
  }

  // Clean object URL on unload
  window.addEventListener('beforeunload', () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });

  window.addEventListener('resize', positionKeybar);
})();
