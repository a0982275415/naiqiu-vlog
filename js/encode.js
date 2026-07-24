/* 影片合成管線：canvas 繪製 + WebAudio 原聲 + MediaRecorder 輸出 */
const Encode = (() => {
  let audioCtx = null;

  function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function pickMime() {
    const candidates = [
      'video/mp4;codecs=avc1.640028,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm',
    ];
    for (const m of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  function fileExt() {
    return pickMime().startsWith('video/mp4') ? 'mp4' : 'webm';
  }

  /* 工作區：Safari 需要 canvas / video 在 DOM 裡才穩定產出畫格 */
  function workbench() {
    let el = document.getElementById('encode-workbench');
    if (!el) {
      el = document.createElement('div');
      el.id = 'encode-workbench';
      el.style.cssText = 'position:fixed;left:-99999px;top:0;width:1px;height:1px;overflow:hidden;';
      document.body.appendChild(el);
    }
    return el;
  }

  /* 等到 loadeddata（readyState>=2）才算就緒：
     只等 metadata 的話第一幀還沒解碼，畫到 canvas 會是黑的 */
  function loadVideo(blob) {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      v.playsInline = true;
      v.preload = 'auto';
      v.muted = true;
      v.src = URL.createObjectURL(blob);
      v.onloadeddata = () => resolve(v);
      v.onerror = () => reject(new Error('video-load-failed'));
      workbench().appendChild(v);
      setTimeout(() => resolve(v), 4000);   // 保險
    });
  }

  /* 確保影片已經停在 start 且有畫面可畫 */
  function seekReady(v, start) {
    return new Promise(res => {
      const done = () => { v.removeEventListener('seeked', done); res(); };
      if (Math.abs(v.currentTime - start) < 0.02 && v.readyState >= 2) return res();
      v.addEventListener('seeked', done);
      v.currentTime = start;
      setTimeout(res, 600);
    });
  }

  function disposeVideo(v) {
    try { v.pause(); } catch (e) {}
    URL.revokeObjectURL(v.src);
    v.remove();
  }

  /* 影片畫面填滿畫布（置中裁切）。來源可以是 <video> 或 WebCodecs 的 VideoFrame */
  function drawCover(ctx, v, W, H) {
    const vw = v.videoWidth || v.displayWidth || v.codedWidth;
    const vh = v.videoHeight || v.displayHeight || v.codedHeight;
    if (!vw || !vh) return;
    const scale = Math.max(W / vw, H / vh);
    const dw = vw * scale, dh = vh * scale;
    ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }

  function wrapLines(ctx, text, maxWidth) {
    const chars = [...text];
    const lines = [];
    let line = '';
    for (const ch of chars) {
      if (ctx.measureText(line + ch).width > maxWidth && line) {
        lines.push(line);
        line = ch;
      } else {
        line += ch;
      }
    }
    if (line) lines.push(line);
    return lines.slice(0, 2);
  }

  /* 畫面正中央一行：Vlog ｜ 字幕 ｜ 時間 */
  function drawOverlays(ctx, clip, dateLabel, W, H) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.6)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    const y = H / 2;
    const pad = Math.round(W * 0.05);

    /* 左：Vlog 標記 */
    ctx.font = `400 ${Math.round(W * 0.062)}px "Cubic 11", "PingFang TC", monospace`;
    ctx.textAlign = 'left';
    ctx.fillText('Vlog', pad, y);

    /* 右：拍攝時間 */
    ctx.textAlign = 'right';
    ctx.fillText(clip.time, W - pad, y);

    /* 中：字幕（沒打就不顯示） */
    const sub = (clip.subtitle || '').trim();
    if (sub) {
      ctx.font = `400 ${Math.round(W * 0.052)}px "Cubic 11", "PingFang TC", monospace`;
      ctx.textAlign = 'center';
      const lines = wrapLines(ctx, sub, W * 0.5);
      const lh = Math.round(W * 0.075);
      const y0 = y - ((lines.length - 1) * lh) / 2;
      lines.forEach((ln, i) => ctx.fillText(ln, W / 2, y0 + i * lh));
    }
    ctx.restore();
  }

  /* 播放一段影片、把每一格畫到 canvas。
     用固定 30fps 的計時迴圈驅動（一定會觸發，不會像 rVFC 那樣在某些環境卡住），
     每畫一格就 pushFrame() 手動送進錄影流 —— 不會像自動側錄那樣漏格（卡頓的根源）。
     另有硬性逾時保護：每段最多跑 dur+1.5 秒，絕不可能無限卡住。 */
  function playThrough(v, start, dur, draw, cancel, pushFrame) {
    return new Promise(async (resolve) => {
      let stopped = false;
      const finish = () => { if (stopped) return; stopped = true; try { v.pause(); } catch (e) {} resolve(); };
      try {
        await seekReady(v, start);
        draw(); pushFrame && pushFrame();   // 交接瞬間先送一格新畫面
        await v.play();
      } catch (e) { return finish(); }

      const t0 = performance.now();
      const hardStop = setTimeout(finish, (dur + 1.5) * 1000);   // 保險：絕不卡死
      let lastPush = -1;
      const FRAME = 1000 / 30;   // 穩定 30fps：畫面順、檔案不會爆

      const tick = () => {
        if (stopped) return;
        if (cancel.on) { clearTimeout(hardStop); return finish(); }
        draw();
        const now = performance.now();
        if (pushFrame && now - lastPush >= FRAME) { pushFrame(); lastPush = now; }
        const wall = (now - t0) / 1000;
        if (v.ended || v.currentTime - start >= dur || wall >= dur + 0.3) {
          clearTimeout(hardStop);
          return finish();
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  async function record(canvas, dur, run, cancel) {
    const ctx2 = getAudioCtx();
    const dest = ctx2.createMediaStreamDestination();

    /* 優先用「手動送格」模式（captureStream(0) + requestFrame）：我們每畫一格就送一格，
       不會被瀏覽器自動側錄漏格 → 不卡頓。
       裝置不支援 requestFrame 就退回自動 30fps 側錄（原本的行為）。 */
    let stream, pushFrame = null;
    try {
      stream = canvas.captureStream(0);
      const vtrack = stream.getVideoTracks()[0];
      if (vtrack && typeof vtrack.requestFrame === 'function') {
        pushFrame = () => { try { vtrack.requestFrame(); } catch (e) {} };
      } else {
        stream.getTracks().forEach(t => t.stop());
        stream = canvas.captureStream(30);   // 退回自動側錄
      }
    } catch (e) {
      stream = canvas.captureStream(30);
    }
    record._pushFrame = pushFrame;   // 沒有就是 null，playThrough 會略過

    stream.addTrack(dest.stream.getAudioTracks()[0]);
    const mime = pickMime();
    const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(r => { rec.onstop = r; });
    rec.start(250);
    try {
      await run(dest);
    } finally {
      try { rec.stop(); } catch (e) {}
      await Promise.race([stopped, new Promise(r => setTimeout(r, 3000))]);   // 保險：stop 卡住也不會永遠等
      stream.getTracks().forEach(t => t.stop());
    }
    record._pushFrame = null;
    if (cancel.on) return null;
    return new Blob(chunks, { type: (mime || 'video/webm').split(';')[0] });
  }

  /* 合成一天：clips 依時間排序、1080x1920、原聲 */
  async function composeDaily(clips, dateLabel, onProgress, cancel, orient = 'portrait') {
    /* 先把像素字型載齊，字卡才不會變成系統字 */
    try { await document.fonts.load('400 64px "Cubic 11"', '奶球0123'); } catch (e) {}
    const W = orient === 'landscape' ? 1920 : 1080;
    const H = orient === 'landscape' ? 1080 : 1920;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    workbench().appendChild(canvas);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);

    let vids = [];
    try {
      /* 所有片段「同時」載入並先 seek 到第一幀。
         以前是一段一段依序等載入，光載入就吃掉大半時間 */
      vids = await Promise.all(clips.map(c => loadVideo(c.videoBlob)));
      await Promise.all(vids.map(v => seekReady(v, 0)));

      /* 音訊來源先接好（createMediaElementSource 同一個 video 只能建立一次） */
      const audioCtx = getAudioCtx();
      const srcs = vids.map(v => {
        try { return audioCtx.createMediaElementSource(v); } catch (e) { return null; }
      });

      /* 解碼器暖機：先播一下再停回起點。
         不做的話，每段正式開播前要等解碼器啟動，那段時間畫面會凍住（停格） */
      await Promise.all(vids.map(async v => {
        try {
          v.muted = true;
          await v.play();
          v.pause();
          await seekReady(v, 0);
        } catch (e) {}
      }));

      /* 預熱：錄影前先把第一段的第一幀畫上畫布，否則成品開頭是黑的 */
      if (vids[0]) {
        drawCover(ctx, vids[0], W, H);
        drawOverlays(ctx, clips[0], dateLabel, W, H);
      }

      const blob = await record(canvas, clips.length * 2, async dest => {
        for (let i = 0; i < clips.length; i++) {
          if (cancel.on) return;
          onProgress(i + 1, clips.length);
          const v = vids[i];
          if (srcs[i]) srcs[i].connect(dest);
          v.muted = false; v.volume = 1;
          await playThrough(v, 0, 2.05, () => {
            drawCover(ctx, v, W, H);
            drawOverlays(ctx, clips[i], dateLabel, W, H);
          }, cancel, record._pushFrame);
          if (srcs[i]) srcs[i].disconnect();
        }
      }, cancel);
      return blob;
    } finally {
      vids.forEach(disposeVideo);
      canvas.remove();
    }
  }

  /* 匯入：從影片檔擷取 start 起 2 秒（不疊字，保留原始比例，最長邊 1920） */
  async function trimSegment(file, start, cancel) {
    const v = await loadVideo(file);
    try {
      const scale = Math.min(1, 1920 / Math.max(v.videoWidth, v.videoHeight));
      const W = Math.round((v.videoWidth * scale) / 2) * 2;
      const H = Math.round((v.videoHeight * scale) / 2) * 2;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      workbench().appendChild(canvas);
      const ctx = canvas.getContext('2d');
      let thumb = null;

      /* 預熱：先跳到起點畫上第一幀，否則匯入的片段開頭是黑的 */
      await new Promise(res => {
        const paint = () => { ctx.drawImage(v, 0, 0, W, H); res(); };
        const onSeeked = () => { paint(); v.removeEventListener('seeked', onSeeked); };
        v.addEventListener('seeked', onSeeked);
        v.currentTime = start;
        setTimeout(res, 1500);
      });

      const blob = await record(canvas, 2, async dest => {
        const src = getAudioCtx().createMediaElementSource(v);
        src.connect(dest);
        v.muted = false; v.volume = 1;
        await playThrough(v, start, 2.0, () => {
          ctx.drawImage(v, 0, 0, W, H);
          if (!thumb) thumb = makeThumbFromCanvas(canvas);
        }, cancel, record._pushFrame);
        src.disconnect();
      }, cancel);
      canvas.remove();
      const thumbBlob = thumb ? await thumb : null;
      return blob ? { blob, thumbBlob } : null;
    } finally {
      disposeVideo(v);
    }
  }

  function makeThumbFromCanvas(source) {
    const t = document.createElement('canvas');
    const size = 240;
    t.width = size; t.height = size;
    const c = t.getContext('2d');
    const s = Math.max(size / source.width, size / source.height);
    c.drawImage(source, (size - source.width * s) / 2, (size - source.height * s) / 2,
      source.width * s, source.height * s);
    return new Promise(r => t.toBlob(r, 'image/jpeg', 0.8));
  }

  /* 從 video 元素抓正方形縮圖 */
  function makeThumbFromVideo(v) {
    const t = document.createElement('canvas');
    const size = 240;
    t.width = size; t.height = size;
    const c = t.getContext('2d');
    const vw = v.videoWidth, vh = v.videoHeight;
    const s = Math.max(size / vw, size / vh);
    c.drawImage(v, (size - vw * s) / 2, (size - vh * s) / 2, vw * s, vh * s);
    return new Promise(r => t.toBlob(r, 'image/jpeg', 0.8));
  }

  return {
    pickMime, fileExt, getAudioCtx, composeDaily, trimSegment, makeThumbFromVideo,
    drawCover, drawOverlays,   // 給快速引擎（encode2）共用，疊字排版才會一致
  };
})();
