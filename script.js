(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const W = canvas.width;
  const H = canvas.height;
  const urlInput = document.getElementById('urlInput');
  const fileInput = document.getElementById('fileInput');
  const analyzeBtn = document.getElementById('analyzeBtn');
  const startBtn = document.getElementById('startBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const restartBtn = document.getElementById('restartBtn');
  const statusEl = document.getElementById('status');
  const scoreEl = document.getElementById('score');
  const comboEl = document.getElementById('combo');
  const maxComboEl = document.getElementById('maxCombo');
  const accEl = document.getElementById('acc');
  const bpmEl = document.getElementById('bpm');
  const audioEl = document.getElementById('player');

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
  const LANE_COLORS = ['#4fc3f7', '#ff8a65', '#aed581', '#ce93d8'];
  const HITLINE_Y = H - 140;
  const NOTE_SPEED_LEAD = 2.2; // seconds from spawn to hitline
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
    const notes = [];
    let lane = 0;
    for (const t of times) {
      lane = (lane + (Math.random() < 0.2 ? 2 : 1)) % LANES;
      notes.push({ time: t, lane, hit: false, judged: false, result: null });
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

      startBtn.disabled = false;
      pauseBtn.disabled = true;
      restartBtn.disabled = true;
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

    // Hit line
    ctx.strokeStyle = '#ffffff33';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, HITLINE_Y);
    ctx.lineTo(W, HITLINE_Y);
    ctx.stroke();

    // Notes
    for (const note of chart) {
      const dt = note.time - t;
      if (note.judged && note.result === 'miss') continue; // hide late misses
      if (dt < -0.5 && !note.hit) continue; // long gone
      const laneX = (note.lane + 0.5) * laneWidth;
      const y = HITLINE_Y - (dt / NOTE_SPEED_LEAD) * TRAVEL;
      // Only draw around screen
      if (y < -40 || y > H + 40) continue;
      ctx.fillStyle = LANE_COLORS[note.lane];
      const w = laneWidth * 0.7;
      const h = 16;
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
      e.preventDefault();
      if (!playing) return;
      const t = audioEl.currentTime || 0;
      judgeKey(lane, t);
    }
  }, { passive: false });

  analyzeBtn.addEventListener('click', analyze);
  startBtn.addEventListener('click', startGame);
  pauseBtn.addEventListener('click', togglePause);
  restartBtn.addEventListener('click', restart);

  // Clean object URL on unload
  window.addEventListener('beforeunload', () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });
})();
