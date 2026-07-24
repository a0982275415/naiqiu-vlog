/* 快速合成引擎（WebCodecs）
   舊引擎（encode.js / MediaRecorder）必須「實時播完」才錄得到，20 秒影片就要等 20 秒。
   這裡改成：mp4box 拆出畫格 → 硬體解碼 → 疊字 → 硬體編碼 → mp4-muxer 封裝。
   完全不用播放，實測快約 7 倍。不支援的裝置會自動退回舊引擎。 */
const Encode2 = (() => {
  const FPS = 30;
  const FRAME_US = 1e6 / FPS;
  const CLIP_US = 2.02e6;   // 每段只取 2 秒（錄影實際可能 2.0~2.1 秒）

  /* 缺哪一項就回報哪一項，方便在畫面上診斷 */
  function missing() {
    const need = [
      ['VideoEncoder', typeof VideoEncoder !== 'undefined'],
      ['VideoDecoder', typeof VideoDecoder !== 'undefined'],
      ['AudioEncoder', typeof AudioEncoder !== 'undefined'],
      ['AudioData', typeof AudioData !== 'undefined'],
      ['MP4Box', typeof window.MP4Box !== 'undefined'],
      ['Mp4Muxer', typeof window.Mp4Muxer !== 'undefined'],
    ];
    return need.filter(([, ok]) => !ok).map(([n]) => n);
  }

  function supported() { return missing().length === 0; }

  /* 這條快路只吃 mp4/H.264（iPhone 錄的就是）。Android 的 webm 走舊引擎 */
  function canUse(clips) {
    return supported() && clips.length > 0 &&
           clips.every(c => (c.videoBlob.type || '').includes('mp4'));
  }

  /* 不能用快速引擎的原因（給畫面顯示） */
  function whyNot(clips) {
    const m = missing();
    if (m.length) return `缺 ${m.join('/')}`;
    const bad = clips.find(c => !(c.videoBlob.type || '').includes('mp4'));
    if (bad) return `片段格式 ${bad.videoBlob.type || '未知'}`;
    return '';
  }

  /* 各家瀏覽器吃的 H.264 規格不同（Safari 常常不吃 Baseline），
     所以先一個一個問過，挑它真的支援的 */
  async function pickVideoCodec(W, H) {
    const candidates = [
      'avc1.640028',   // High 4.0
      'avc1.4d0028',   // Main 4.0
      'avc1.42002A',   // Baseline 4.2
      'avc1.640033',   // High 5.1（大尺寸）
      'avc1.4d0033',   // Main 5.1
    ];
    for (const codec of candidates) {
      try {
        const r = await VideoEncoder.isConfigSupported({
          codec, width: W, height: H, bitrate: 6_000_000, framerate: FPS,
        });
        if (r && r.supported) return codec;
      } catch (e) { /* 試下一個 */ }
    }
    return null;
  }

  /* 診斷：這台裝置的能力（錯誤時附上，才有辦法遠端判斷） */
  function deviceTag() {
    const ua = navigator.userAgent || '';
    const m = ua.match(/OS (\d+)[._](\d+)/);   // iOS 版本
    const ios = m ? `iOS${m[1]}.${m[2]}` : '';
    return ios || (ua.match(/Chrome\/(\d+)/) ? 'Chrome' + RegExp.$1 : 'web');
  }

  /* 解碼器設定。
     iOS 的硬體 codec 資源很有限：解碼器和編碼器同時搶硬體時，
     第二段要重啟解碼器就會 Decoder failure。
     所以「解碼走軟體、編碼留給硬體」，兩邊不打架。 */
  async function pickDecoderConfig(cfg, preferSoftware = true) {
    const variants = preferSoftware
      ? [{ ...cfg, hardwareAcceleration: 'prefer-software' }, cfg]
      : [cfg, { ...cfg, hardwareAcceleration: 'prefer-software' }];
    for (const c of variants) {
      try {
        const r = await VideoDecoder.isConfigSupported(c);
        if (r && r.supported) return c;
      } catch (e) { /* 試下一個 */ }
    }
    throw new Error(`不支援 ${cfg.codec} ${cfg.codedWidth}x${cfg.codedHeight}`);
  }

  async function pickAudioCodec(sampleRate, channels) {
    try {
      const r = await AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate: 128_000,
      });
      if (r && r.supported) return 'mp4a.40.2';
    } catch (e) {}
    return null;
  }

  /* AAC-LC 的音訊規格說明（AudioSpecificConfig，2 bytes）。
     Safari 的 AudioEncoder 常常不附 decoderConfig.description，mp4-muxer 就只好寫一份全 0 的規格進檔案
     → 看起來有音軌、實際上任何播放器都解不開（整支變靜音）。這裡自己算一份補上去。 */
  const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  function aacAsc(sampleRate, channels) {
    const i = AAC_RATES.indexOf(sampleRate);
    if (i < 0 || channels < 1 || channels > 7) return null;
    return new Uint8Array([(2 << 3) | (i >> 1), ((i & 1) << 7) | (channels << 3)]);
  }
  function descLen(d) {
    if (!d) return 0;
    return d.byteLength != null ? d.byteLength : (d.length || 0);
  }
  function fixAudioMeta(meta, sampleRate, channels, acodec) {
    const dc = meta && meta.decoderConfig;
    if (dc && descLen(dc.description) > 0) return meta;
    const asc = aacAsc(sampleRate, channels);
    if (!asc) return meta;
    return {
      ...(meta || {}),
      decoderConfig: { codec: acodec, sampleRate, numberOfChannels: channels, ...(dc || {}), description: asc },
    };
  }

  /* 成品自檢：用瀏覽器自己的解碼器把成品的音軌解一次。
     解不開＝這支檔在手機上就是沒聲音，寧可丟錯誤退回可靠引擎，也不要交出一支靜音檔。 */
  async function audioPlayable(blob) {
    try {
      const actx = Encode.getAudioCtx();
      const ab = await blob.arrayBuffer();
      const buf = await new Promise((res, rej) => {
        const p = actx.decodeAudioData(ab, res, rej);
        if (p && typeof p.then === 'function') p.then(res, rej);
      });
      return !!(buf && buf.length > 0 && buf.numberOfChannels > 0);
    } catch (e) { return false; }
  }

  /* 背景 JPEG 壓縮小工池：把「壓成 JPEG」這件苦工丟給幾個 Web Worker 同時做。
     iPhone 主執行緒的 toBlob 是單線瓶頸（一秒 ~19 張）；分給背景多工並行，主線只負責
     擷取畫面（很快），就能貼近 30fps。裝置不支援（舊 iOS）就回 null，讓呼叫端退回單線 toBlob。 */
  function makeJpegPool(size) {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' ||
        typeof createImageBitmap === 'undefined') return null;
    try { if (!new OffscreenCanvas(2, 2).convertToBlob) return null; } catch (e) { return null; }

    const code = `self.onmessage = async (e) => {
      const { id, bitmap, q } = e.data;
      try {
        const c = new OffscreenCanvas(bitmap.width, bitmap.height);
        c.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close();
        const blob = await c.convertToBlob({ type: 'image/jpeg', quality: q });
        self.postMessage({ id, blob });
      } catch (err) { self.postMessage({ id, blob: null }); }
    };`;
    let url;
    try { url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); }
    catch (e) { return null; }

    const waiting = new Map();   // id -> resolve
    const workers = [];
    try {
      for (let i = 0; i < size; i++) {
        const w = new Worker(url);
        w.onmessage = e => {
          const r = waiting.get(e.data.id);
          if (r) { waiting.delete(e.data.id); r(e.data.blob); }
        };
        w.onerror = () => {};
        workers.push(w);
      }
    } catch (e) { workers.forEach(w => w.terminate()); URL.revokeObjectURL(url); return null; }

    let rr = 0, nextId = 1, pending = 0;
    return {
      get pending() { return pending; },
      /* 傳入一張 ImageBitmap（會被 transfer 過去，零複製），回傳壓好的 JPEG blob */
      encode(bitmap) {
        const id = nextId++;
        const w = workers[rr++ % workers.length];
        pending++;
        return new Promise(res => {
          waiting.set(id, res);
          try { w.postMessage({ id, bitmap, q: 0.85 }, [bitmap]); }
          catch (e) { waiting.delete(id); res(null); }
        }).then(b => { pending--; return b; });
      },
      destroy() {
        workers.forEach(w => { try { w.terminate(); } catch (e) {} });
        try { URL.revokeObjectURL(url); } catch (e) {}
      },
    };
  }

  /* 影片的旋轉標記（tkhd matrix，16.16 定點數）→ 角度 */
  function matrixToDegrees(m) {
    if (!m || m.length < 5) return 0;
    const U = 65536;
    const a = Math.round(m[0] / U), b = Math.round(m[1] / U);
    if (a === 0 && b === 1) return 90;
    if (a === -1 && b === 0) return 180;
    if (a === 0 && b === -1) return 270;
    return 0;
  }

  /* 把畫格轉正、填滿畫布（置中裁切） */
  function drawFrame(ctx, frame, W, H, rot) {
    const fw = frame.displayWidth || frame.codedWidth;
    const fh = frame.displayHeight || frame.codedHeight;
    const turned = (rot === 90 || rot === 270);
    const ew = turned ? fh : fw;     // 轉正後的實際寬高
    const eh = turned ? fw : fh;
    const scale = Math.max(W / ew, H / eh);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    if (rot) ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(frame, (-fw * scale) / 2, (-fh * scale) / 2, fw * scale, fh * scale);
    ctx.restore();
  }

  /* 畫格暫存到硬碟（IndexedDB），不佔記憶體。
     一天十幾段 = 快 900 張全尺寸 JPEG（250MB+），全放記憶體 iPhone 會被系統殺掉。 */
  function frameStore() {
    const DB = 'nq-frames-tmp';
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((res, rej) => {
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('f'); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return dbp;
    }
    return {
      async put(i, blob) {
        const db = await open();
        await new Promise((res, rej) => {
          const t = db.transaction('f', 'readwrite');
          t.objectStore('f').put(blob, i);
          t.oncomplete = res; t.onerror = () => rej(t.error);
        });
      },
      async get(i) {
        const db = await open();
        return new Promise((res, rej) => {
          const r = db.transaction('f', 'readonly').objectStore('f').get(i);
          r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        });
      },
      async destroy() {
        try { if (dbp) (await dbp).close(); } catch (e) {}
        dbp = null;
        await new Promise(res => { const r = indexedDB.deleteDatabase(DB); r.onsuccess = r.onerror = res; });
      },
    };
  }

  /* 用 mp4box 把 mp4 拆成一顆顆已編碼的畫格 */
  function demux(blob) {
    return new Promise(async (resolve, reject) => {
      const file = MP4Box.createFile();
      const samples = [];
      let cfg = null;
      let rotation = 0;
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve({ cfg, samples, rotation }); } };

      file.onError = e => { if (!settled) { settled = true; reject(new Error('demux: ' + e)); } };
      file.onReady = info => {
        const track = info.videoTracks[0];
        if (!track) return reject(new Error('no video track'));
        const trak = file.getTrackById(track.id);
        let desc = null;
        for (const entry of trak.mdia.minf.stbl.stsd.entries) {
          const box = entry.avcC || entry.hvcC;
          if (box) {
            const s = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
            box.write(s);
            /* 只取「實際寫入」的長度：DataStream 的 buffer 可能預留多餘空間，
               Chrome 會容忍尾巴，但 Safari 很嚴格，多一個位元組就 decoder failure */
            const end = (typeof s.position === 'number' && s.position > 8)
              ? s.position
              : s.buffer.byteLength;
            desc = new Uint8Array(s.buffer.slice(8, end));   // 去掉 box header
            break;
          }
        }
        cfg = {
          codec: track.codec,
          codedWidth: track.video.width,
          codedHeight: track.video.height,
          description: desc,
        };
        /* 手機直拍的影片，畫格其實是橫的，另外附一個「播放時轉 90 度」的標記。
           解碼器不會幫我們轉，所以要自己讀出來、畫的時候補上 */
        rotation = matrixToDegrees(track.matrix);
        file.setExtractionOptions(track.id, null, { nbSamples: 10000 });
        file.start();
      };
      file.onSamples = (id, user, s) => samples.push(...s);

      try {
        const buf = await blob.arrayBuffer();
        buf.fileStart = 0;
        file.appendBuffer(buf);
        file.flush();
        setTimeout(finish, 80);
      } catch (e) { reject(e); }
    });
  }

  /* 音訊：把每段的聲音解出來、串起來，用 AAC 編碼進成品 */
  /* 交給編碼器前把樣本整理乾淨：
     1) 頭尾各 3ms 淡入淡出 —— 兩段硬接波形會跳一下，聽起來就是每個接縫「喀」一聲
     2) 鎖在 ±1 之內 —— decodeAudioData 重取樣後可能微幅超過滿刻度，超過就破音 */
  function dressSamples(inter, n, channels, sampleRate) {
    if (n <= 0) return;
    const F = Math.min(Math.round(sampleRate * 0.003), n >> 1);
    for (let i = 0; i < F; i++) {
      const gIn = i / F;
      const gOut = (i + 1) / F;
      for (let ch = 0; ch < channels; ch++) {
        inter[i * channels + ch] *= gIn;
        inter[(n - 1 - i) * channels + ch] *= gOut;
      }
    }
    for (let i = 0; i < inter.length; i++) {
      if (inter[i] > 1) inter[i] = 1;
      else if (inter[i] < -1) inter[i] = -1;
    }
  }

  async function buildAudio(clips, muxer, sampleRate, channels, acodec) {
    /* 用裝置本身那顆共用 AudioContext（自然取樣率），不要新開強制 48000 的——
       iOS Safari 對強制取樣率的第二個 context 會做出壞音軌(22050Hz/0聲道)，整支變靜音。 */
    const actx = Encode.getAudioCtx();
    let audioErr = null, chunks = 0;
    const enc = new AudioEncoder({
      output: (chunk, meta) => { chunks++; muxer.addAudioChunk(chunk, fixAudioMeta(meta, sampleRate, channels, acodec)); },
      error: e => { audioErr = e; },
    });
    enc.configure({ codec: acodec, sampleRate, numberOfChannels: channels, bitrate: 128_000 });

    let tsUs = 0;
    for (const c of clips) {
      let buf = null;
      try {
        buf = await actx.decodeAudioData(await c.videoBlob.arrayBuffer());
      } catch (e) { /* 這段沒有聲音 → 用靜音補滿，時間軸才不會跑掉 */ }
      const want = Math.round(sampleRate * (CLIP_US / 1e6));
      const n = buf ? Math.min(buf.length, want) : want;

      const inter = new Float32Array(n * channels);
      if (buf) {
        for (let ch = 0; ch < channels; ch++) {
          const src = buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1));
          for (let i = 0; i < n; i++) inter[i * channels + ch] = src[i];
        }
        dressSamples(inter, n, channels, sampleRate);
      }
      const CH = 1024;
      for (let off = 0; off < n; off += CH) {
        const cnt = Math.min(CH, n - off);
        enc.encode(new AudioData({
          format: 'f32-planar',
          sampleRate,
          numberOfFrames: cnt,
          numberOfChannels: channels,
          timestamp: tsUs,
          data: inter.slice(off * channels, (off + cnt) * channels),
        }));
        tsUs += (cnt / sampleRate) * 1e6;
      }
    }
    await enc.flush();
    enc.close();
    /* 不 close actx：那是全 App 共用的，關掉之後就沒聲音了 */
    /* 音訊整個編不出來（iOS 壞掉）→ 明確報錯，讓外層退回可靠引擎(一定有聲音)，別吐出靜音壞檔 */
    if (audioErr) throw audioErr;
    if (chunks === 0) throw new Error('音訊沒有編出任何資料');
  }

  /* 解碼器只開「一個」，每段 reset 後重用。
     iOS 對硬體解碼器的實例數限制很嚴：每段都 new 一個，第 2 段就 decoder failure。
     （Chrome 沒這個限制，所以電腦上完全看不出問題） */
  function createDecoder() {
    let dec = null;
    let handler = null;
    let failed = null;
    let lastKey = null;      // 上一段的格式指紋

    const keyOf = cfg => `${cfg.codec}|${cfg.hardwareAcceleration || ''}|` +
      (cfg.description ? cfg.description.byteLength + ':' + cfg.description[0] : '');

    function ensure(cfg, samples) {
      if (dec && dec.state !== 'closed') return dec;
      dec = new VideoDecoder({
        output: f => { if (handler) handler(f); else f.close(); },
        error: e => {
          failed = new Error(
            `解碼失敗 ${deviceTag()} ${cfg.codec} ` +
            `desc${cfg.description ? cfg.description.byteLength : 0}B ` +
            `${cfg.codedWidth}x${cfg.codedHeight} s${samples.length} ` +
            `hw:${cfg.hardwareAcceleration || 'auto'} :: ${(e && (e.message || e.name)) || e}`
          );
        },
      });
      lastKey = null;
      return dec;
    }

    /* onFrame 可以是 async：畫格會排隊、一格一格處理完才繼續解下一格。
       不做背壓的話，一次會有幾十張全尺寸畫面同時卡在記憶體，iPhone 直接記憶體不足 */
    async function decodeRange(cfg, samples, startUs, endUs, onFrame) {
      if (!cfg.description || !cfg.description.byteLength) {
        throw new Error('讀不到影片編碼參數(avcC)');
      }
      failed = null;
      const d = ensure(cfg, samples);

      const queue = [];
      handler = f => queue.push(f);

      const pump = async () => {
        while (queue.length) {
          if (failed) { queue.forEach(x => x.close()); queue.length = 0; throw failed; }
          const f = queue.shift();
          await onFrame(f);           // 序列處理，處理完才輪下一格
        }
      };
      const breathe = () => new Promise(r => setTimeout(r, 0));

      /* 格式一樣就不要重新設定解碼器 —— 每段都 reset+configure，
         iOS 到第二段就會 Decoder failure。每段都從關鍵格開始送，
         所以不重設也解得出來。 */
      const key = keyOf(cfg);
      if (d.state !== 'configured' || key !== lastKey) {
        if (d.state === 'configured') d.reset();
        d.configure(cfg);
        lastKey = key;
      }
      if (failed) throw failed;

      /* 從起點前最近的關鍵格開始解，不要從頭解整支影片 */
      let from = 0;
      for (let i = 0; i < samples.length; i++) {
        const ts = (samples[i].cts * 1e6) / samples[i].timescale;
        if (ts > startUs) break;
        if (samples[i].is_sync) from = i;
      }
      for (let i = from; i < samples.length; i++) {
        const s = samples[i];
        const ts = (s.cts * 1e6) / s.timescale;
        if (ts >= endUs) break;
        if (failed) throw failed;
        d.decode(new EncodedVideoChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: ts,
          duration: (s.duration * 1e6) / s.timescale,
          /* 複製一份：mp4box 給的是指向大緩衝區的視窗，iOS 餵 view 進去會失敗 */
          data: new Uint8Array(s.data),
        }));
        /* 背壓：解碼器排隊太長就先停下來，把已解出的畫格處理掉再繼續 */
        if (d.decodeQueueSize > 2 || queue.length > 2) {
          await breathe();
          await pump();
        }
      }
      await d.flush();
      await breathe();
      await pump();
      handler = null;
      if (failed) throw failed;
    }

    function close() {
      handler = null;
      try { if (dec && dec.state !== 'closed') dec.close(); } catch (e) {}
      dec = null;
    }

    return { decodeRange, close };
  }

  /* 解碼一段 → 疊字 → 每格壓成 JPEG，暫存在「記憶體」（只有這一段的量，約 15MB）。
     解碼期間絕不碰硬碟／編碼器 —— 那會把 iOS 的硬體解碼器卡到超時被回收。
     一律補滿 perClip 格，段落長度才一致。回傳這段的 JPEG 陣列。 */
  async function decodeClipToJpegs({ decoder, cfg, samples, rotation, startUs, ctx, canvas, W, H, layer, cancel }) {
    const perClip = Math.round((CLIP_US / 1e6) * FPS);
    const endUs = startUs + CLIP_US;
    let done = 0;
    let painted = false;
    const blobs = [];

    /* 一格壓一格（toBlob 約 5~15ms，不會卡住解碼器；畫質 0.88 肉眼看不出差別）。
       只放記憶體、不碰硬碟，等這段解完再批次落地 */
    const snap = async () => {
      const b = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.88));
      if (b) blobs.push(b);
      done++;
    };

    await decoder.decodeRange(cfg, samples, startUs, endUs, async f => {
      try {
        if (cancel.on || done >= perClip) return;
        const rel = f.timestamp - startUs;
        if (rel < -FRAME_US) return;      // 關鍵格到起點之間，只是為了解碼
        while (done < perClip && done * FRAME_US <= rel + FRAME_US / 2) {
          if (!painted || done * FRAME_US >= rel - FRAME_US) {
            drawFrame(ctx, f, W, H, rotation);
            if (layer) ctx.drawImage(layer, 0, 0);
            painted = true;
          }
          await snap();
        }
      } finally {
        f.close();   // 立刻釋放，絕不累積 VideoFrame
      }
    });

    while (!cancel.on && painted && done < perClip) await snap();
    return blobs;
  }

  /* 從硬碟一張張讀回 JPEG 幀、編碼進 mp4（此時解碼器已全部關閉）。
     times[i]＝這張畫面的絕對時間戳(微秒)。有給就照真實時間播(可變影格率、動作最順)；
     沒給就退回固定 30fps（快速引擎那條路仍是均勻的，維持原樣）。 */
  async function encodeFromStore(store, total, { ctx, canvas, W, H, encoder, cancel, getErr, times }) {
    const tsAt = i => (times ? times[i] : i * FRAME_US);
    for (let i = 0; i < total; i++) {
      if (cancel.on) return;
      const err = getErr(); if (err) throw err;
      const blob = await store.get(i);
      if (!blob) continue;
      const bmp = await createImageBitmap(blob);
      ctx.drawImage(bmp, 0, 0, W, H);
      bmp.close();
      const dur = (times && i + 1 < total) ? Math.max(1, times[i + 1] - times[i]) : FRAME_US;
      const nf = new VideoFrame(canvas, {
        timestamp: Math.round(tsAt(i)),
        duration: Math.round(dur),
      });
      encoder.encode(nf, { keyFrame: i % 60 === 0 });
      nf.close();
      if (encoder.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 0));
    }
  }

  async function composeDaily(clips, dateLabel, onProgress, cancel, orient = 'portrait', opts = {}) {
    const preferSoftware = opts.preferSoftware !== false;   // 預設解碼走軟體，避免和硬體編碼器搶資源
    try { await document.fonts.load('400 64px "Cubic 11"', '奶球0123'); } catch (e) {}

    const W = orient === 'landscape' ? 1920 : 1080;
    const H = orient === 'landscape' ? 1080 : 1920;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    const vcodec = await pickVideoCodec(W, H);
    if (!vcodec) throw new Error(`無支援的 H.264 規格 ${W}x${H}`);
    const sampleRate = 48000, channels = 1;
    const acodec = await pickAudioCodec(sampleRate, channels);

    /* ===== 階段一：只解碼，每格壓成 JPEG 寫進硬碟（編碼器完全沒開）=====
       iOS 上解碼器和編碼器不能同時運作，且畫面不能全堆記憶體，所以徹底分開＋落地硬碟。 */
    const store = frameStore();
    const counter = { v: 0 };
    /* 整趟共用一個解碼器（iOS 釋放硬體解碼器很慢，連續新建會失敗）。
       記憶體靠「每段落地硬碟後清空」控制，不靠關解碼器。 */
    const decoder = createDecoder();
    try {
      for (let i = 0; i < clips.length; i++) {
        if (cancel.on) { await store.destroy(); return null; }
        onProgress(i + 1, clips.length);

        const clip = clips[i];
        const { cfg: rawCfg, samples, rotation } = await demux(clip.videoBlob);
        if (!rawCfg) throw new Error('無法解析影片');
        const cfg = await pickDecoderConfig(rawCfg, preferSoftware);

        const layer = document.createElement('canvas');
        layer.width = W; layer.height = H;
        Encode.drawOverlays(layer.getContext('2d'), clip, dateLabel, W, H);

        /* 解碼期間只在記憶體收集（不碰硬碟，才不會卡住硬體解碼器） */
        const segBlobs = await decodeClipToJpegs({
          decoder, cfg, samples, rotation, startUs: 0,
          ctx, canvas, W, H, layer, cancel,
        });
        /* 這段解完，才把畫格批次寫進硬碟；記憶體隨即清空，不會累積 */
        for (const b of segBlobs) await store.put(counter.v++, b);
        segBlobs.length = 0;
      }

      const total = counter.v;
      if (cancel.on || !total) { decoder.close(); await store.destroy(); return null; }
      decoder.close();   // 解碼全部完成，關掉解碼器，才能開編碼器

      /* ===== 階段二：只編碼，從硬碟一張張讀回（解碼器已全關）===== */
      const { Muxer, ArrayBufferTarget } = Mp4Muxer;
      const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: 'avc', width: W, height: H },
        ...(acodec ? { audio: { codec: 'aac', sampleRate, numberOfChannels: channels } } : {}),
        fastStart: 'in-memory',
      });
      let encErr = null;
      const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: e => { encErr = e; },
      });
      encoder.configure({ codec: vcodec, width: W, height: H, bitrate: 6_000_000, framerate: FPS, latencyMode: 'realtime' });

      await encodeFromStore(store, total, { ctx, canvas, W, H, encoder, cancel, getErr: () => encErr });

      if (cancel.on) { try { encoder.close(); } catch (e) {} return null; }
      if (encErr) throw encErr;

      await encoder.flush();
      encoder.close();
      if (acodec) await buildAudio(clips, muxer, sampleRate, channels, acodec);
      muxer.finalize();
      return new Blob([muxer.target.buffer], { type: 'video/mp4' });
    } finally {
      decoder.close();          // 保險：出錯時也把解碼器放掉
      await store.destroy();    // 清掉硬碟上的暫存畫格
    }
  }

  /* 匯入用的快速裁切：一樣走硬體解碼／編碼，不用實時播 2 秒 */
  async function trimSegment(file, start, cancel) {
    if (!supported()) return null;

    const { cfg: rawCfg, samples, rotation } = await demux(file);
    if (!rawCfg) return null;
    const cfg = await pickDecoderConfig(rawCfg);

    const startUs = start * 1e6;
    const endUs = startUs + CLIP_US;

    /* 目標尺寸：維持「轉正後」的比例，最長邊 1920（偶數）。
       直拍的影片畫格是橫的，轉 90 度後寬高要對調 */
    const turned = (rotation === 90 || rotation === 270);
    const sw = turned ? cfg.codedHeight : cfg.codedWidth;
    const sh = turned ? cfg.codedWidth : cfg.codedHeight;
    const scale = Math.min(1, 1920 / Math.max(sw, sh));
    const W = Math.round((sw * scale) / 2) * 2;
    const H = Math.round((sh * scale) / 2) * 2;

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    const vcodec = await pickVideoCodec(W, H);
    if (!vcodec) throw new Error(`無支援的 H.264 規格 ${W}x${H}`);
    const sampleRate = 48000, channels = 1;
    const acodec = await pickAudioCodec(sampleRate, channels);

    /* ===== 階段一：只解碼成 JPEG 寫進硬碟（編碼器沒開）===== */
    const store = frameStore();
    const counter = { v: 0 };
    let total = 0, thumb = null;
    try {
      const decoder = createDecoder();
      let segBlobs;
      try {
        segBlobs = await decodeClipToJpegs({
          decoder, cfg, samples, rotation, startUs,
          ctx, canvas, W, H, layer: null, cancel,
        });
      } finally {
        decoder.close();
      }
      if (!cancel.on && segBlobs[0]) thumb = await makeThumbFromJpeg(segBlobs[0]);
      for (const b of segBlobs) await store.put(counter.v++, b);
      segBlobs.length = 0;
      total = counter.v;
      if (cancel.on || !total) { await store.destroy(); return null; }

      /* ===== 階段二：只編碼（解碼器已關閉）===== */
      const { Muxer, ArrayBufferTarget } = Mp4Muxer;
      const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: 'avc', width: W, height: H },
        ...(acodec ? { audio: { codec: 'aac', sampleRate, numberOfChannels: channels } } : {}),
        fastStart: 'in-memory',
      });
      let encErr = null;
      const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: e => { encErr = e; },
      });
      encoder.configure({ codec: vcodec, width: W, height: H, bitrate: 6_000_000, framerate: FPS, latencyMode: 'realtime' });

      await encodeFromStore(store, total, { ctx, canvas, W, H, encoder, cancel, getErr: () => encErr });
      if (cancel.on) { try { encoder.close(); } catch (e) {} return null; }
      if (encErr) throw encErr;

      await encoder.flush();
      encoder.close();

    /* 音訊：只取那 2 秒 */
    try {
      if (!acodec) throw new Error('no audio codec');
      const AC = window.AudioContext || window.webkitAudioContext;
      const actx = new AC({ sampleRate });
      const buf = await actx.decodeAudioData(await file.arrayBuffer());
      const enc = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: e => console.warn('audio', e),
      });
      enc.configure({ codec: acodec, sampleRate, numberOfChannels: channels, bitrate: 128_000 });
      const from = Math.floor(start * sampleRate);
      const n = Math.min(buf.length - from, Math.round(sampleRate * (CLIP_US / 1e6)));
      const inter = new Float32Array(Math.max(0, n) * channels);
      for (let ch = 0; ch < channels; ch++) {
        const src = buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1));
        for (let i = 0; i < n; i++) inter[i * channels + ch] = src[from + i] || 0;
      }
      let tsUs = 0;
      const CH = 1024;
      for (let off = 0; off < n; off += CH) {
        const cnt = Math.min(CH, n - off);
        enc.encode(new AudioData({
          format: 'f32-planar', sampleRate, numberOfFrames: cnt, numberOfChannels: channels,
          timestamp: tsUs, data: inter.slice(off * channels, (off + cnt) * channels),
        }));
        tsUs += (cnt / sampleRate) * 1e6;
      }
      await enc.flush();
      enc.close();
      actx.close();
      } catch (e) { /* 這支影片沒聲音也沒關係 */ }

      muxer.finalize();
      return {
        blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }),
        thumbBlob: thumb,
      };
    } finally {
      await store.destroy();   // 清掉硬碟上的暫存畫格
    }
  }

  /* ═══════════════════════════════════════════════════════════════
     混合引擎：用 <video> 解碼（iOS 可靠）+ WebCodecs 編碼（iOS 可用）
     部分 iOS 的 VideoDecoder 對這些 mp4 一律 decoder failure，
     但 <video> 播放器解碼一向可靠。所以「解碼」改用 <video> 逐格 seek 抓圖，
     其餘（編碼、音訊、封裝）沿用上面同一套。
     逐格 seek = 決定性時間軸，完全沒有即時播放的接縫凍結；
     聲音走獨立的 decodeAudioData 管線，所以「seek 不出聲」不影響。
     ═══════════════════════════════════════════════════════════════ */

  /* 混合引擎需要的能力（不需要 VideoDecoder / MP4Box）。
     連音訊編碼也一起要求：缺了的話寧可退回可靠引擎（有聲音），
     也不要產出「順但沒聲音」的成品。 */
  function canUseHybrid(clips) {
    const ok = typeof VideoEncoder !== 'undefined' &&
               typeof VideoFrame !== 'undefined' &&
               typeof AudioEncoder !== 'undefined' &&
               typeof AudioData !== 'undefined' &&
               typeof window.Mp4Muxer !== 'undefined';
    return ok && clips.length > 0 &&
           clips.every(c => (c.videoBlob.type || '').includes('mp4'));
  }

  function loadVideoEl(blob) {
    return new Promise(resolve => {
      const v = document.createElement('video');
      v.playsInline = true; v.preload = 'auto'; v.muted = true;
      v.src = URL.createObjectURL(blob);
      v.style.cssText = 'position:fixed;left:-99999px;top:0;width:1px;height:1px;';
      let done = false;
      const fin = () => { if (done) return; done = true; resolve(v); };
      v.onloadeddata = fin;
      document.body.appendChild(v);
      setTimeout(fin, 4000);   // 保險：載不出來也不卡死
    });
  }

  /* 精準跳到 t 秒、等「畫面真的解好」才往下（優先用 requestVideoFrameCallback，抓得到正確畫面又不乾等）；每次都有 timeout 保險 → 絕不無限等 */
  function seekEl(v, t) {
    return new Promise(res => {
      let done = false;
      const onSeek = () => fin();
      const fin = () => { if (done) return; done = true; v.removeEventListener('seeked', onSeek); res(); };
      /* 已經在這一格了，畫面就是對的，直接用（避免無謂等待）*/
      if (Math.abs(v.currentTime - t) < 1e-3 && v.readyState >= 2) { setTimeout(fin, 0); return; }
      v.addEventListener('seeked', onSeek);
      if (typeof v.requestVideoFrameCallback === 'function') {
        v.requestVideoFrameCallback(() => fin());   // 新畫面實際上桌那一刻才 resolve
      }
      try { v.currentTime = t; } catch (e) { return fin(); }
      setTimeout(fin, 500);   // 保險：真的卡住也不無限等
    });
  }

  /* 跳到 t 秒，而且「確認畫面真的到了 t」才回報成功。
     用 requestVideoFrameCallback 的 mediaTime 驗：呈現出來的那張畫面若跟目標差超過 tol 秒，
     繼續等下一張；等到逾時就回報失敗（畫面可信度優先，寧缺勿錯）。 */
  function seekVerified(v, t, tol) {
    return new Promise(res => {
      let done = false;
      const fin = ok => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        v.removeEventListener('seeked', onSeeked);
        res(ok);
      };
      const timer = setTimeout(() => fin(false), 700);   // 逾時算失敗，絕不硬收
      /* 正規通道：seeked 事件＝瀏覽器宣告「跳完了」，此時畫面就是目標那格 */
      const onSeeked = () => fin(Math.abs(v.currentTime - t) <= Math.max(tol, 0.05));
      v.addEventListener('seeked', onSeeked);
      /* 快速通道：新畫面上桌時帶著自己的時間戳，對得上就提早收工 */
      if (typeof v.requestVideoFrameCallback === 'function') {
        const watch = (now, meta) => {
          if (done) return;
          const mt = (meta && typeof meta.mediaTime === 'number') ? meta.mediaTime : NaN;
          if (Math.abs(mt - t) <= tol) return fin(true);
          try { v.requestVideoFrameCallback(watch); } catch (e) {}
        };
        v.requestVideoFrameCallback(watch);
      }
      try { v.currentTime = t; } catch (e) { fin(false); }
    });
  }

  function disposeVideoEl(v) {
    try { v.pause(); } catch (e) {}
    try { URL.revokeObjectURL(v.src); } catch (e) {}
    try { v.remove(); } catch (e) {}
  }

  /* <video> 已自動套用旋轉，videoWidth/Height 就是顯示方向，直接置中裁切填滿 */
  function drawCoverEl(ctx, v, W, H) {
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return false;
    const s = Math.max(W / vw, H / vh);
    ctx.drawImage(v, (W - vw * s) / 2, (H - vh * s) / 2, vw * s, vh * s);
    return true;
  }

  /* 從一個已載入的 <video>，自 startSec 起把影片「播一遍」，畫面吐出來就收，每張記時間戳。
     絕不 seek 回頭補格 —— 那是之前晃動的元凶（iPhone seek 常畫面沒真的跳到就回報跳好）。
     速度關鍵：用「一組捕捉畫布」讓好幾張同時壓縮，不再一張壓完才收下一張 ——
       單張 toBlob 在 iPhone 要 ~50ms，一張一張排隊只抓得到 ~19fps（畫面偏卡）；
       多張並行壓，就能貼近螢幕的 30fps，成品更滑。
     完成順序可能亂（誰先壓完誰先回來），所以最後依時間戳排序，順序仍保證單調。 */
  async function framesFromVideoEl(v, { startSec, ctx, canvas, W, H, layer, cancel }) {
    const dur = CLIP_US / 1e6;                            // 2.02 秒

    /* 背景多工壓縮：有的話主線只負責「畫＋快照」，把 JPEG 壓縮丟給背景 → 貼近 30fps；
       沒有（舊 iOS）就退回單線 toBlob（會慢，但一定能動）。 */
    const jpeg = makeJpegPool(4);                         // 4 個背景小工並行壓（iPhone 多核心吃得下）
    const MAX_INFLIGHT = 8;                               // 在壓的張數上限（放寬換張數，記憶體抓在 ~90MB 安全內）

    /* 主畫布：畫影片＋疊字，之後快照給背景壓（用一張就好，快照當下即凍結內容）*/
    const work = document.createElement('canvas');
    work.width = W; work.height = H;
    const wctx = work.getContext('2d');
    const drawFrame = () => {
      wctx.fillStyle = '#000';
      wctx.fillRect(0, 0, W, H);
      if (!drawCoverEl(wctx, v, W, H)) return false;
      return true;
    };
    const isPitchBlack = () => {
      try {
        const pts = [[W >> 2, H >> 2], [W >> 1, H >> 1], [W - (W >> 2), H >> 2],
                     [W >> 2, H - (H >> 2)], [W - (W >> 2), H - (H >> 2)]];
        for (const [x, y] of pts) {
          const d = wctx.getImageData(x, y, 1, 1).data;
          if (d[0] > 8 || d[1] > 8 || d[2] > 8) return false;
        }
        return true;
      } catch (e) { return false; }
    };

    /* 單線退路用的畫布池（沒有背景多工時才用）*/
    const pool = [];
    if (!jpeg) for (let i = 0; i < 4; i++) {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      pool.push({ ctx: c.getContext('2d'), el: c, free: true });
    }

    const caps = [];   // { t, blob }，完成順序可能亂，最後排序
    let inflight = 0, sawPicture = false;
    v.muted = true;
    try { await seekEl(v, startSec); } catch (e) {}

    await new Promise(async (resolve) => {
      let stopped = false;
      const pendingCount = () => (jpeg ? jpeg.pending : inflight);
      const finish = () => {
        if (stopped) return;
        stopped = true;
        try { v.pause(); } catch (e) {}
        const wait = () => ((pendingCount() || inflight) ? setTimeout(wait, 10) : resolve());
        wait();
      };
      try { await v.play(); } catch (e) { return finish(); }
      const hardStop = setTimeout(finish, (dur + 2.5) * 1000);   // 絕不無限等

      /* 背景多工版：畫→快照(createImageBitmap，快)→丟背景壓，主線不等 */
      const grabWorker = (rel) => {
        if (jpeg.pending >= MAX_INFLIGHT) return;           // 背景塞爆了，這格讓它過
        if (!drawFrame()) return;
        if (!sawPicture && isPitchBlack()) return;
        sawPicture = true;
        if (layer) wctx.drawImage(layer, 0, 0);
        inflight++;
        createImageBitmap(work)
          .then(bmp => jpeg.encode(bmp))
          .then(b => { inflight--; if (b && !stopped) caps.push({ t: rel, blob: b }); })
          .catch(() => { inflight--; });
      };
      /* 單線退路版：畫到空閒池子畫布，toBlob */
      const grabPool = (rel) => {
        const slot = pool.find(p => p.free);
        if (!slot) return;
        slot.ctx.fillStyle = '#000'; slot.ctx.fillRect(0, 0, W, H);
        if (!drawCoverEl(slot.ctx, v, W, H)) return;
        if (!sawPicture) {                                  // 只在開頭驗黑（借主畫布驗一次）
          if (drawFrame() && isPitchBlack()) return;
          sawPicture = true;
        }
        if (layer) slot.ctx.drawImage(layer, 0, 0);
        slot.free = false; inflight++;
        slot.el.toBlob(b => {
          slot.free = true; inflight--;
          if (b && !stopped) caps.push({ t: rel, blob: b });
        }, 'image/jpeg', 0.85);
      };
      const grab = (t) => {
        const rel = t - startSec;
        if (rel < -0.02) return;
        if (jpeg) grabWorker(rel); else grabPool(rel);
      };
      let queue = null;
      const step = (t) => {
        if (stopped) return;
        if (cancel.on) { clearTimeout(hardStop); return finish(); }
        grab(t);
        if (v.ended || (t - startSec) >= dur - 1e-3) { clearTimeout(hardStop); return finish(); }
        queue();
      };
      queue = typeof v.requestVideoFrameCallback === 'function'
        ? () => v.requestVideoFrameCallback((now, meta) =>
            step(meta && typeof meta.mediaTime === 'number' ? meta.mediaTime : v.currentTime))
        : () => requestAnimationFrame(() => step(v.currentTime));
      queue();
    });

    /* 一張都沒播出來（極少數）：最後保底 seek 抓一張，總比空白好 */
    if (!caps.length && !cancel.on) {
      try { await seekEl(v, startSec); } catch (e) {}
      if (drawFrame()) {
        if (layer) wctx.drawImage(layer, 0, 0);
        const b = await new Promise(res => work.toBlob(res, 'image/jpeg', 0.85));
        if (b) caps.push({ t: 0, blob: b });
      }
    }
    if (jpeg) jpeg.destroy();
    if (!caps.length) return [];

    /* 並行壓縮完成順序可能亂 → 依時間戳排序，順序仍保證單調（不會晃動）。
       時間戳只用來排序；真正的「均勻鋪時間」在 composeDailyHybrid 用張數做，這裡只保證前後對。 */
    caps.sort((a, b) => a.t - b.t);
    caps[0].t = 0;
    let prev = -1;
    for (const c of caps) {
      if (c.t <= prev) c.t = prev + 1e-3;
      if (c.t > dur - 1e-3) c.t = dur - 1e-3;
      prev = c.t;
    }
    return caps;   // [{ t, blob }]，t 為這段內的相對秒數
  }

  /* 階段二共用：從硬碟畫格編碼 + 疊音訊 + 封裝成 mp4 */
  async function encodeStoreToMp4(store, total, { W, H, ctx, canvas, vcodec, acodec, sampleRate, channels, cancel, onAudio, times }) {
    const { Muxer, ArrayBufferTarget } = Mp4Muxer;
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: W, height: H },
      ...(acodec ? { audio: { codec: 'aac', sampleRate, numberOfChannels: channels } } : {}),
      fastStart: 'in-memory',
    });
    let encErr = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: e => { encErr = e; },
    });
    encoder.configure({ codec: vcodec, width: W, height: H, bitrate: 6_000_000, framerate: FPS, latencyMode: 'realtime' });
    await encodeFromStore(store, total, { ctx, canvas, W, H, encoder, cancel, getErr: () => encErr, times });
    if (cancel.on) { try { encoder.close(); } catch (e) {} return null; }
    if (encErr) throw encErr;
    await encoder.flush();
    encoder.close();
    if (acodec && onAudio) await onAudio(muxer);
    muxer.finalize();
    return new Blob([muxer.target.buffer], { type: 'video/mp4' });
  }

  /* 混合引擎：合成一天。
     先試「直接編碼」（邊播邊編、跳過 JPEG，iPhone 上能貼近 30fps 最順）；
     萬一這台裝置播放與編碼會打架（少數 iOS 版本），自動退回「JPEG 兩階段」那條穩的路。 */
  async function composeDailyHybrid(clips, dateLabel, onProgress, cancel, orient = 'portrait') {
    /* 直接編碼在這台壞過就記住，之後直接走穩的兩階段 —— 不再讓使用者看到進度條跑兩次。
       （iPhone 播放與編碼不能同時進行，多數 iOS 會走到這個 flag；Chrome 則永遠成功。） */
    let liveBroken = false;
    try { liveBroken = localStorage.getItem('nq-live-broken') === '1'; } catch (e) {}
    if (!liveBroken) {
      try {
        const live = await composeDailyLive(clips, dateLabel, onProgress, cancel, orient);
        if (live) return live;
        if (cancel.on) return null;
        try { localStorage.setItem('nq-live-broken', '1'); } catch (e) {}   // 沒報錯但沒產出＝這台不行
      } catch (e) {
        console.warn('直接編碼失敗，改用 JPEG 兩階段：', e);
        if (cancel.on) return null;
        try { localStorage.setItem('nq-live-broken', '1'); } catch (e) {}
      }
    }
    return composeDailyStaged(clips, dateLabel, onProgress, cancel, orient);
  }

  /* 直接編碼（單階段）：播 <video>，每出來一張畫面就疊字、直接餵給編碼器，不經過 JPEG。
     JPEG 壓縮在 iPhone 是單線瓶頸（一秒只擠得出 ~19 張）；跳過它，編碼器跟得上 30fps 播放，
     畫面就滿格＝最滑。播放本身是均勻 30fps → 時間戳自然等距，不會卡頓。 */
  async function composeDailyLive(clips, dateLabel, onProgress, cancel, orient = 'portrait') {
    try { await document.fonts.load('400 64px "Cubic 11"', '奶球0123'); } catch (e) {}
    const W = orient === 'landscape' ? 1920 : 1080;
    const H = orient === 'landscape' ? 1080 : 1920;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    const vcodec = await pickVideoCodec(W, H);
    if (!vcodec) throw new Error(`無支援的 H.264 規格 ${W}x${H}`);
    const channels = 1;
    const sampleRate = ((Encode.getAudioCtx && Encode.getAudioCtx().sampleRate) || 48000);
    const acodec = await pickAudioCodec(sampleRate, channels);

    const { Muxer, ArrayBufferTarget } = Mp4Muxer;
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: W, height: H },
      ...(acodec ? { audio: { codec: 'aac', sampleRate, numberOfChannels: channels } } : {}),
      fastStart: 'in-memory',
    });
    let encErr = null, frameCount = 0, closed = false;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: e => { encErr = e; },
    });
    const closeEncoder = () => { if (!closed) { closed = true; try { encoder.close(); } catch (e) {} } };
    encoder.configure({ codec: vcodec, width: W, height: H, bitrate: 6_000_000, framerate: FPS, latencyMode: 'realtime' });

    /* 用 try/finally 兜底：不管成功、失敗、還是退回，這顆編碼器一定關掉，
       否則 iOS 上一顆沒關的硬體編碼器會害「退回 JPEG」那條也開不了編碼器。 */
    try {
      let lastTs = -1;
      for (let i = 0; i < clips.length; i++) {
        if (cancel.on) return null;
        if (encErr) throw encErr;
        onProgress(i + 1, clips.length);
        const clip = clips[i];
        const layer = document.createElement('canvas');
        layer.width = W; layer.height = H;
        Encode.drawOverlays(layer.getContext('2d'), clip, dateLabel, W, H);

        const v = await loadVideoEl(clip.videoBlob);
        try {
          const n = await playAndEncode(v, {
            base: i * CLIP_US, ctx, canvas, W, H, layer, encoder,
            cancel, getErr: () => encErr, minTs: () => lastTs,
            onEncoded: ts => { lastTs = ts; frameCount++; },
          });
          if (!n) throw new Error(`第 ${i + 1} 段一張都沒編出來`);   // 直接編碼在這台不行 → 退回 JPEG
        } finally { disposeVideoEl(v); }
        if (encErr) throw encErr;
      }

      if (cancel.on || !frameCount) return null;
      if (encErr) throw encErr;
      await encoder.flush();
      if (encErr) throw encErr;
    } finally {
      closeEncoder();
    }

    if (acodec) await buildAudio(clips, muxer, sampleRate, channels, acodec);
    muxer.finalize();
    const out = new Blob([muxer.target.buffer], { type: 'video/mp4' });
    if (acodec && !cancel.on && !(await audioPlayable(out))) {
      throw new Error('成品的音軌解不開（這台裝置的 WebCodecs 音訊有問題）');
    }
    return out;
  }

  /* 播一段影片，每張畫面疊字後直接餵編碼器。回傳這段編了幾張。 */
  async function playAndEncode(v, { base, ctx, canvas, W, H, layer, encoder, cancel, getErr, minTs, onEncoded }) {
    const dur = CLIP_US / 1e6;   // 2.02 秒
    let count = 0, sawPicture = false;
    const isPitchBlack = () => {
      try {
        const pts = [[W >> 2, H >> 2], [W >> 1, H >> 1], [W - (W >> 2), H >> 2],
                     [W >> 2, H - (H >> 2)], [W - (W >> 2), H - (H >> 2)]];
        for (const [x, y] of pts) {
          const d = ctx.getImageData(x, y, 1, 1).data;
          if (d[0] > 8 || d[1] > 8 || d[2] > 8) return false;
        }
        return true;
      } catch (e) { return false; }
    };

    v.muted = true;
    try { await seekEl(v, 0); } catch (e) {}

    await new Promise(async (resolve) => {
      let stopped = false;
      const finish = () => { if (stopped) return; stopped = true; try { v.pause(); } catch (e) {} resolve(); };
      try { await v.play(); } catch (e) { return finish(); }
      const hardStop = setTimeout(finish, (dur + 2.5) * 1000);

      const emit = (t) => {
        if (getErr() || t < -0.02) return;
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        if (!drawCoverEl(ctx, v, W, H)) return;
        if (!sawPicture && isPitchBlack()) return;   // 開頭解碼器沒醒的黑格丟掉
        sawPicture = true;
        if (layer) ctx.drawImage(layer, 0, 0);
        let ts = Math.round(base + Math.min(t, dur - 1e-3) * 1e6);
        if (ts <= minTs()) ts = minTs() + 1;         // 時間戳必須嚴格遞增
        const nf = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(FRAME_US) });
        encoder.encode(nf, { keyFrame: count % 60 === 0 });
        nf.close();
        count++; onEncoded(ts);
      };

      let queue = null;
      const step = (t) => {
        if (stopped) return;
        if (cancel.on || getErr()) { clearTimeout(hardStop); return finish(); }
        emit(t);
        if (v.ended || t >= dur - 1e-3) { clearTimeout(hardStop); return finish(); }
        queue();
      };
      queue = typeof v.requestVideoFrameCallback === 'function'
        ? () => v.requestVideoFrameCallback((now, meta) =>
            step(meta && typeof meta.mediaTime === 'number' ? meta.mediaTime : v.currentTime))
        : () => requestAnimationFrame(() => step(v.currentTime));
      queue();
    });
    return count;
  }

  /* 混合引擎（穩定備援）：JPEG 兩階段 —— 邊播邊壓 JPEG 落地，再讀回來編碼 */
  async function composeDailyStaged(clips, dateLabel, onProgress, cancel, orient = 'portrait') {
    try { await document.fonts.load('400 64px "Cubic 11"', '奶球0123'); } catch (e) {}
    const W = orient === 'landscape' ? 1920 : 1080;
    const H = orient === 'landscape' ? 1080 : 1920;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    const vcodec = await pickVideoCodec(W, H);
    if (!vcodec) throw new Error(`無支援的 H.264 規格 ${W}x${H}`);
    const channels = 1;
    const sampleRate = ((Encode.getAudioCtx && Encode.getAudioCtx().sampleRate) || 48000);   // 用裝置真實取樣率
    const acodec = await pickAudioCodec(sampleRate, channels);

    const store = frameStore();
    const counter = { v: 0 };
    const times = [];        // 每張畫面的絕對時間戳(微秒)；每段固定佔 CLIP_US，段內用真實相對時間
    try {
      /* 階段一：每段用 <video> 播放捕捉 → JPEG → 硬碟（不碰 WebCodecs 解碼器） */
      for (let i = 0; i < clips.length; i++) {
        if (cancel.on) { await store.destroy(); return null; }
        onProgress(i + 1, clips.length);
        const clip = clips[i];
        const layer = document.createElement('canvas');
        layer.width = W; layer.height = H;
        Encode.drawOverlays(layer.getContext('2d'), clip, dateLabel, W, H);

        const v = await loadVideoEl(clip.videoBlob);
        let caps = [];
        try {
          caps = await framesFromVideoEl(v, { startSec: 0, ctx, canvas, W, H, layer, cancel });
        } finally { disposeVideoEl(v); }
        /* 均勻鋪時間，不用真實時間戳：iPhone 抓畫面忽快忽慢，照真實時間播 →
           每張停留時間忽長忽短＝卡頓。改成這段抓到的 N 張畫面在 2.02 秒裡「等距」排開，
           每張停一樣久 → 節奏穩＝順（幀率可能只有 19，但均勻的 19 遠比忽快忽慢的順）。 */
        const base = i * CLIP_US;   // 這段在整支影片裡的起點，鎖死每段 2.02 秒 → 音訊對得上
        const N = caps.length;
        for (let k = 0; k < N; k++) {
          await store.put(counter.v++, caps[k].blob);
          times.push(base + Math.round((k * CLIP_US) / N));
        }
        caps.length = 0;
      }

      const total = counter.v;
      if (cancel.on || !total) { await store.destroy(); return null; }

      /* 階段二：編碼 + 音訊（與快速引擎同一套，iOS 上這兩步是好的） */
      const out = await encodeStoreToMp4(store, total, {
        W, H, ctx, canvas, vcodec, acodec, sampleRate, channels, cancel, times,
        onAudio: muxer => buildAudio(clips, muxer, sampleRate, channels, acodec),
      });
      /* 交件前先自己聽一次：音軌解不開就別交，退回可靠引擎重做（那條路一定有聲音） */
      if (out && acodec && !cancel.on && !(await audioPlayable(out))) {
        throw new Error('成品的音軌解不開（這台裝置的 WebCodecs 音訊有問題）');
      }
      return out;
    } finally {
      await store.destroy();
    }
  }

  /* 混合引擎：匯入裁切（自 start 起 2 秒，保留原始比例、最長邊 1920） */
  async function trimSegmentHybrid(file, start, cancel) {
    const probe = await loadVideoEl(file);
    const vw = probe.videoWidth, vh = probe.videoHeight;
    if (!vw || !vh) { disposeVideoEl(probe); return null; }
    const scale = Math.min(1, 1920 / Math.max(vw, vh));
    const W = Math.round((vw * scale) / 2) * 2;
    const H = Math.round((vh * scale) / 2) * 2;

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    const vcodec = await pickVideoCodec(W, H);
    if (!vcodec) { disposeVideoEl(probe); throw new Error(`無支援的 H.264 規格 ${W}x${H}`); }
    const channels = 1;
    const sampleRate = ((Encode.getAudioCtx && Encode.getAudioCtx().sampleRate) || 48000);   // 用裝置真實取樣率
    const acodec = await pickAudioCodec(sampleRate, channels);

    const store = frameStore();
    const counter = { v: 0 };
    const times = [];
    let thumb = null;
    try {
      let caps = [];
      try {
        caps = await framesFromVideoEl(probe, { startSec: start, ctx, canvas, W, H, layer: null, cancel });
      } finally { disposeVideoEl(probe); }
      if (!cancel.on && caps[0]) thumb = await makeThumbFromJpeg(caps[0].blob);
      /* 同 composeDailyHybrid：均勻鋪時間，每張停一樣久才不卡頓 */
      const N = caps.length;
      for (let k = 0; k < N; k++) {
        await store.put(counter.v++, caps[k].blob);
        times.push(Math.round((k * CLIP_US) / N));
      }
      caps.length = 0;

      const total = counter.v;
      if (cancel.on || !total) { await store.destroy(); return null; }

      const blob = await encodeStoreToMp4(store, total, {
        W, H, ctx, canvas, vcodec, acodec, sampleRate, channels, cancel, times,
        onAudio: muxer => buildAudioTrim(file, start, muxer, sampleRate, channels, acodec),
      });
      if (!blob) return null;
      /* 匯入的片段沒聲音的話，之後合成整天也會缺一段聲音 → 一樣先自檢 */
      if (acodec && !cancel.on && !(await audioPlayable(blob))) {
        throw new Error('匯入片段的音軌解不開（這台裝置的 WebCodecs 音訊有問題）');
      }
      return { blob, thumbBlob: thumb };
    } finally {
      await store.destroy();
    }
  }

  /* 匯入音訊：只取 start 起 2 秒 */
  async function buildAudioTrim(file, start, muxer, sampleRate, channels, acodec) {
    /* 用共用 AudioContext 的自然取樣率（同 buildAudio 的 iOS 修正）；不 close 它 */
    const actx = Encode.getAudioCtx();
    let audioErr = null, chunks = 0;
    const buf = await actx.decodeAudioData(await file.arrayBuffer());
    const enc = new AudioEncoder({
      output: (chunk, meta) => { chunks++; muxer.addAudioChunk(chunk, fixAudioMeta(meta, sampleRate, channels, acodec)); },
      error: e => { audioErr = e; },
    });
    enc.configure({ codec: acodec, sampleRate, numberOfChannels: channels, bitrate: 128_000 });
    const from = Math.floor(start * sampleRate);
    const n = Math.min(buf.length - from, Math.round(sampleRate * (CLIP_US / 1e6)));
    const inter = new Float32Array(Math.max(0, n) * channels);
    for (let ch = 0; ch < channels; ch++) {
      const src = buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1));
      for (let i = 0; i < n; i++) inter[i * channels + ch] = src[from + i] || 0;
    }
    dressSamples(inter, Math.max(0, n), channels, sampleRate);
    let tsUs = 0;
    const CH = 1024;
    for (let off = 0; off < n; off += CH) {
      const cnt = Math.min(CH, n - off);
      enc.encode(new AudioData({
        format: 'f32-planar', sampleRate, numberOfFrames: cnt, numberOfChannels: channels,
        timestamp: tsUs, data: inter.slice(off * channels, (off + cnt) * channels),
      }));
      tsUs += (cnt / sampleRate) * 1e6;
    }
    await enc.flush(); enc.close();
    /* 音訊整個編不出來 → 報錯，讓匯入退回可靠引擎(有聲音)，不留壞音軌 */
    if (audioErr) throw audioErr;
    if (chunks === 0) throw new Error('音訊沒有編出任何資料');
  }

  /* 從第一張 JPEG 幀做正方形縮圖 */
  async function makeThumbFromJpeg(jpeg) {
    try {
      const bmp = await createImageBitmap(jpeg);
      const t = document.createElement('canvas');
      const size = 240;
      t.width = size; t.height = size;
      const c = t.getContext('2d');
      const s = Math.max(size / bmp.width, size / bmp.height);
      c.drawImage(bmp, (size - bmp.width * s) / 2, (size - bmp.height * s) / 2, bmp.width * s, bmp.height * s);
      bmp.close();
      return await new Promise(r => t.toBlob(r, 'image/jpeg', 0.8));
    } catch (e) { return null; }
  }

  /* 從畫布做正方形縮圖（照片匯入用，不必先壓成 JPEG） */
  async function makeThumbFromCanvas(src) {
    try {
      const size = 240;
      const t = document.createElement('canvas');
      t.width = size; t.height = size;
      const c = t.getContext('2d');
      const s = Math.max(size / src.width, size / src.height);
      c.drawImage(src, (size - src.width * s) / 2, (size - src.height * s) / 2, src.width * s, src.height * s);
      return await new Promise(r => t.toBlob(r, 'image/jpeg', 0.8));
    } catch (e) { return null; }
  }

  /* 這台裝置能不能匯入照片：只需要「編碼器」，不碰壞掉的 VideoDecoder，所以 iPhone 也 OK */
  function canImportPhoto() {
    return typeof VideoEncoder !== 'undefined' &&
           typeof VideoFrame !== 'undefined' &&
           typeof window.Mp4Muxer !== 'undefined';
  }

  /* 匯入照片 → 定格 2 秒的 mp4 片段（無音軌，合成時 buildAudio 會自動補靜音）。
     保留照片原本比例、最長邊 1920，跟匯入影片一致；合成時再由 drawCover 裁切填滿。 */
  async function imageToClip(file, cancel) {
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });   // 讀 EXIF 轉正
    } catch (e) {
      bmp = await createImageBitmap(file);   // 舊瀏覽器不支援 imageOrientation
    }
    const scale = Math.min(1, 1920 / Math.max(bmp.width, bmp.height));
    const W = Math.max(2, Math.round((bmp.width * scale) / 2) * 2);
    const H = Math.max(2, Math.round((bmp.height * scale) / 2) * 2);

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, W, H);
    bmp.close();

    const thumbBlob = await makeThumbFromCanvas(canvas);

    const vcodec = await pickVideoCodec(W, H);
    if (!vcodec) throw new Error(`無支援的 H.264 規格 ${W}x${H}`);

    const { Muxer, ArrayBufferTarget } = Mp4Muxer;
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: W, height: H },
      fastStart: 'in-memory',
    });
    let encErr = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: e => { encErr = e; },
    });
    encoder.configure({ codec: vcodec, width: W, height: H, bitrate: 6_000_000, framerate: FPS, latencyMode: 'realtime' });

    const total = Math.round((CLIP_US / 1e6) * FPS);   // 61 格同一張畫面
    for (let i = 0; i < total; i++) {
      if (cancel.on) { try { encoder.close(); } catch (e) {} return null; }
      if (encErr) throw encErr;
      const nf = new VideoFrame(canvas, {
        timestamp: Math.round(i * FRAME_US),
        duration: Math.round(FRAME_US),
      });
      encoder.encode(nf, { keyFrame: i % 60 === 0 });
      nf.close();
      if (encoder.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 0));
    }
    if (cancel.on) { try { encoder.close(); } catch (e) {} return null; }
    if (encErr) throw encErr;
    await encoder.flush();
    encoder.close();
    muxer.finalize();
    return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), thumbBlob };
  }

  return {
    supported, canUse, whyNot, composeDaily, trimSegment,
    canUseHybrid, composeDailyHybrid, trimSegmentHybrid,
    canImportPhoto, imageToClip,
  };
})();
