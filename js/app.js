/* 奶球 Vlog — 主程式 */
(() => {
  const $ = id => document.getElementById(id);
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const APP_VER = 61;   /* 改版本時：這裡、index.html 的 ?v= 與版本標籤、sw.js 的 CACHE 一起改 */

  /* ---------- 日期工具（一律本地時間） ---------- */
  const pad = n => String(n).padStart(2, '0');
  const dateStrOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayStr = () => dateStrOf(new Date());
  const timeStrOf = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const labelOf = ds => { const [y, m, d] = ds.split('-').map(Number); return `${m}/${d}`; };
  /* 依「影片本身的時間」排序（匯入舊影片才不會被排到最後）；同分鐘再看建立順序 */
  const byTime = (a, b) => (a.time || '').localeCompare(b.time || '') || a.createdAt - b.createdAt;
  const weekdayOf = ds => WEEK[new Date(ds + 'T12:00:00').getDay()];
  const fullTitleOf = ds => { const [y, m, d] = ds.split('-').map(Number); return `${m} 月 ${d} 日（${weekdayOf(ds)}）`; };

  /* ---------- Toast / 對話框 ---------- */
  let toastTimer = null;
  function toast(msg, actionLabel, onAction, ms = 4000) {
    clearTimeout(toastTimer);
    $('toast-msg').textContent = msg;
    const act = $('toast-action');
    if (actionLabel) {
      act.textContent = actionLabel;
      act.hidden = false;
      act.onclick = () => { hideToast(); onAction && onAction(); };
    } else {
      act.hidden = true;
    }
    $('toast').hidden = false;
    toastTimer = setTimeout(hideToast, ms);
  }
  function hideToast() { $('toast').hidden = true; }

  function confirmDialog(msg, okLabel = '確定') {
    return new Promise(resolve => {
      $('dialog-msg').textContent = msg;
      $('dialog-ok').textContent = okLabel;
      $('dialog').hidden = false;
      $('dialog-ok').onclick = () => { $('dialog').hidden = true; resolve(true); };
      $('dialog-cancel').onclick = () => { $('dialog').hidden = true; resolve(false); };
    });
  }

  function buzz() { if (navigator.vibrate) navigator.vibrate(30); }

  /* ---------- 分頁切換 ---------- */
  const views = { capture: $('view-capture'), today: $('view-today'), diary: $('view-diary'), day: $('view-day') };
  let currentTab = 'capture';

  function showView(name) {
    Object.values(views).forEach(v => v.classList.remove('active'));
    views[name].classList.add('active');
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === (name === 'day' ? 'diary' : name));
    });
    /* 離開的頁面把舞台影片暫停，避免背景繼續出聲 */
    if (name !== 'today') document.querySelectorAll('#clip-stage video').forEach(v => v.pause());
    if (name !== 'day') document.querySelectorAll('#day-clip-stage video').forEach(v => v.pause());
    if (name !== 'capture') stopCamera();   // 日頁也會走這裡（openDay 直接呼叫）
  }

  async function switchTab(name) {
    currentTab = name;
    showView(name);
    /* 相機／麥克風只在拍攝頁開著：離開就關掉，
       手機才不會一直亮紅點（錄音指示），也不會在關 app 時「逼」一聲 */
    if (name === 'capture') { ensureCamera(); updateCamHead(); }
    else stopCamera();
    if (name === 'today') renderToday();
    if (name === 'diary') renderCalendar();
  }

  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => switchTab(t.dataset.tab)));

  /* ---------- 相機 ---------- */
  let camStream = null;
  let facing = 'environment';
  let recording = false;
  let zoom = 1;               // 1（0.5× 標籤，最廣）| 2（1× 標籤，拉近）
  let torchOn = false;
  const BEAUTY = 'brightness(1.12) saturate(1.14) contrast(0.94)';
  const BEAUTY_SOFT = 'blur(1.1px)';   // 疊一層柔膚，透明度控制強度

  async function ensureCamera() {
    if (camStream && camStream.active) return;
    await startCamera();
  }

  /* 即時數位變焦：只改預覽 transform，不重啟相機、零黑屏。
     前鏡頭做鏡像（像照鏡子），成品也會鏡像，兩邊一致 */
  function applyPreviewTransform() {
    const mx = facing === 'user' ? -zoom : zoom;
    $('cam-preview').style.transform = `scaleX(${mx}) scaleY(${zoom})`;
  }

  function updateCamButtons() {
    const front = facing === 'user';
    /* 前鏡頭不提供變焦 */
    $('btn-lens').classList.toggle('ghost', front);
    $('lens-label').textContent = zoom >= 2 ? '1×' : '.5×';
    $('btn-lens').classList.toggle('on', zoom >= 2);
    const track = camStream && camStream.getVideoTracks()[0];
    const cap = track && track.getCapabilities ? track.getCapabilities() : null;
    $('btn-flash').classList.toggle('ghost', !(cap && cap.torch));
    $('btn-flash').classList.toggle('on', torchOn);
  }

  async function applyTorch() {
    const track = camStream && camStream.getVideoTracks()[0];
    if (!track || !track.applyConstraints) return;
    try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (e) {}
  }

  async function startCamera() {
    stopCamera();
    /* exact 優先：ideal 只是偏好，部分 Android/三星會忽略而不真的換鏡頭。
       後面才逐步放寬，解決前鏡頭在某些機型開不了的問題 */
    const fm = facing === 'user' ? 'user' : 'environment';
    /* 收音關掉三種「智慧處理」：
       自動增益(AGC)會在安靜房間把麥克風增益催到底 → 整段都是被放大的沙沙底噪；
       回音消除/降噪會把環境音和奶球的聲音處理得忽大忽小。關掉＝自然原聲。 */
    const AUD = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    const tries = [
      { video: { facingMode: { exact: fm }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: AUD },
      { video: { facingMode: { exact: fm } }, audio: AUD },
      { video: { facingMode: { exact: fm } }, audio: true },
      { video: { facingMode: { exact: fm } }, audio: false },
      { video: { facingMode: fm }, audio: AUD },
      { video: { facingMode: fm }, audio: false },
      { video: true, audio: true },
    ];
    let lastErr = null;
    for (const c of tries) {
      try { camStream = await navigator.mediaDevices.getUserMedia(c); break; }
      catch (e) { lastErr = e; camStream = null; }
    }
    if (!camStream) { $('cam-fallback').hidden = false; return; }
    const v = $('cam-preview');
    v.srcObject = camStream;
    if (facing === 'user') zoom = 1;   // 前鏡頭固定 1 倍（不提供變焦）
    applyPreviewTransform();
    $('cam-fallback').hidden = true;
    torchOn = false;
    if (torchOn) await applyTorch();
    updateCamButtons();
  }

  function stopCamera() {
    if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  }

  $('btn-lens').addEventListener('click', () => {
    zoom = zoom >= 2 ? 1 : 2;
    applyPreviewTransform();
    updateCamButtons();
  });
  $('btn-flash').addEventListener('click', async () => {
    torchOn = !torchOn;
    await applyTorch();
    updateCamButtons();
  });

  /* 倒數計時器：關 → 3 秒 → 5 秒 */
  let timerSec = Number(localStorage.getItem('nq-timer') || 0);
  function updateTimerLabel() {
    $('timer-label').textContent = timerSec ? `${timerSec}` : '';
    $('btn-timer').classList.toggle('on', timerSec > 0);
  }
  $('btn-timer').addEventListener('click', () => {
    timerSec = timerSec === 0 ? 3 : timerSec === 3 ? 5 : 0;
    localStorage.setItem('nq-timer', timerSec);
    updateTimerLabel();
  });
  updateTimerLabel();

  let countdownTimer = null;
  function startCountdown(sec, done) {
    let left = sec;
    const el = $('countdown');
    el.textContent = left;
    el.hidden = false;
    countdownTimer = setInterval(() => {
      left--;
      if (left <= 0) { cancelCountdown(); done(); }
      else el.textContent = left;
    }, 1000);
  }
  function cancelCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = null;
    $('countdown').hidden = true;
  }

  /* 拍攝畫面的成品疊字預覽：時間即時更新 */
  function tickClock() { $('shot-time').textContent = timeStrOf(new Date()); }
  tickClock();
  setInterval(tickClock, 5000);

  function updateCamHead() { tickClock(); }

  $('btn-flip').addEventListener('click', () => {
    facing = facing === 'environment' ? 'user' : 'environment';
    applyPreviewTransform();
    startCamera();
  });
  $('btn-cam-retry').addEventListener('click', startCamera);

  /* ---------- 錄 2 秒（支援倒數） ---------- */
  $('btn-record').addEventListener('click', () => {
    if (recording) return;
    if (countdownTimer) { cancelCountdown(); return; }
    Encode.getAudioCtx(); // 在手勢裡先解鎖音訊
    if (timerSec > 0) startCountdown(timerSec, doRecord);
    else doRecord();
  });

  async function doRecord() {
    if (recording) return;
    if (!camStream || !camStream.active) { await startCamera(); if (!camStream) return; }
    recording = true;
    const btn = $('btn-record');
    btn.classList.add('recording');
    views.capture.classList.add('recording');

    /* 經 canvas 錄影：把變焦、鏡像、美顏一起烤進成品，所見即所得 */
    const srcV = $('cam-preview');
    const vw = srcV.videoWidth || 1280;
    const vh = srcV.videoHeight || 720;
    const mirror = facing === 'user';   // 自拍鏡像，跟預覽（照鏡子）一致
    const canvas = document.createElement('canvas');
    canvas.width = vw; canvas.height = vh;
    const ctx = canvas.getContext('2d');
    let drawing = true;
    (function draw() {
      if (!drawing) return;
      // 底層：提亮＋氣色
      ctx.save();
      try { ctx.filter = BEAUTY; } catch (e) {}
      ctx.translate(vw / 2, vh / 2);
      ctx.scale(mirror ? -zoom : zoom, zoom);
      ctx.drawImage(srcV, -vw / 2, -vh / 2, vw, vh);
      ctx.restore();
      // 上層：半透明柔膚（磨皮），保留五官不糊
      ctx.save();
      ctx.globalAlpha = 0.5;
      try { ctx.filter = BEAUTY_SOFT; } catch (e) {}
      ctx.translate(vw / 2, vh / 2);
      ctx.scale(mirror ? -zoom : zoom, zoom);
      ctx.drawImage(srcV, -vw / 2, -vh / 2, vw, vh);
      ctx.restore();
      requestAnimationFrame(draw);
    })();

    const outStream = canvas.captureStream(30);
    const audio = camStream.getAudioTracks()[0];
    if (audio) outStream.addTrack(audio);
    const mime = Encode.pickMime();
    const rec = new MediaRecorder(outStream, { mimeType: mime || undefined, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      drawing = false;
      outStream.getVideoTracks().forEach(t => t.stop()); // 只停 canvas 影格軌，音訊軌屬於相機不停
      btn.classList.remove('recording');
      views.capture.classList.remove('recording');
      recording = false;
      const now = new Date();
      const clip = {
        id: crypto.randomUUID(),
        date: todayStr(),
        time: timeStrOf(now),
        createdAt: now.getTime(),
        subtitle: '',
        videoBlob: new Blob(chunks, { type: (mime || 'video/webm').split(';')[0] }),
        thumbBlob: await makeThumb(canvas),
        source: 'camera',
      };
      await DB.putClip(clip);
      buzz();
      const n = (await DB.clipsByDate(clip.date)).length;
      updateCamHead();
      toast(`已存第 ${n} 段`, '補一句話', () => editSubtitle(clip));
    };
    rec.start();
    setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, 2000);
  }

  /* 從 canvas 抓正方形縮圖 */
  function makeThumb(source) {
    const t = document.createElement('canvas');
    const size = 240;
    t.width = size; t.height = size;
    const c = t.getContext('2d');
    const s = Math.max(size / source.width, size / source.height);
    c.drawImage(source, (size - source.width * s) / 2, (size - source.height * s) / 2,
      source.width * s, source.height * s);
    return new Promise(r => t.toBlob(r, 'image/jpeg', 0.8));
  }

  /* ---------- 字幕編輯 ---------- */
  let subtitleCtx = null;
  /* stage 有給的話：編輯期間定住畫面、存檔只換字不重載影片 */
  function editSubtitle(clip, refresh, keepIndex, stage) {
    subtitleCtx = {
      clip, stage,
      refresh: refresh || (ki => { if (currentTab === 'today') renderToday(ki); }),
      keepIndex,
    };
    if (stage) stage.hold();
    $('subtitle-input').value = clip.subtitle || '';
    $('subtitle-sheet').hidden = false;
    setTimeout(() => $('subtitle-input').focus(), 100);
  }
  function closeSubtitleSheet() {
    if (subtitleCtx && subtitleCtx.stage) subtitleCtx.stage.release();
    $('subtitle-sheet').hidden = true;
    subtitleCtx = null;
  }
  $('subtitle-save').addEventListener('click', async () => {
    if (subtitleCtx) {
      const text = $('subtitle-input').value.trim();
      subtitleCtx.clip.subtitle = text;
      await DB.putClip(subtitleCtx.clip);
      if (subtitleCtx.stage) subtitleCtx.stage.setSubText(text);   // 原地更新，不重繪
      else subtitleCtx.refresh(subtitleCtx.keepIndex);
      refreshSaveButtons();   // 字幕變了 → 成品要重新合成，按鈕文字要跟著改
    }
    closeSubtitleSheet();
  });
  $('subtitle-cancel').addEventListener('click', closeSubtitleSheet);

  /* ---------- 片段舞台元件（今天頁與日頁共用：花朵列＋拍立得＋自動輪播） ---------- */
  function createStage(ids, getRefresh) {
    /* 兩個 video 交替：下一段先在背後載好，有畫面才亮出來 → 段與段之間不閃黑 */
    const vs = [$(ids.video), $(ids.videoB)];
    const urls = [null, null];
    const st = { clips: [], index: -1, cur: 0, token: 0 };
    const video = () => vs[st.cur];

    function clear() {
      st.index = -1;
      $(ids.stage).hidden = true;
      vs.forEach((v, k) => {
        v.pause(); v.removeAttribute('src'); v.load();
        if (urls[k]) { URL.revokeObjectURL(urls[k]); urls[k] = null; }
      });
    }

    /* 單行花朵列：超出寬度用左右箭頭捲動 */
    const rowEl = $(ids.row);
    const arrows = rowEl.parentElement.querySelectorAll('.flower-arrow');
    function updateArrows() {
      const can = rowEl.scrollWidth > rowEl.clientWidth + 4;
      arrows[0].classList.toggle('ghost-a', !can || rowEl.scrollLeft <= 2);
      arrows[1].classList.toggle('ghost-a', !can || rowEl.scrollLeft + rowEl.clientWidth >= rowEl.scrollWidth - 2);
    }
    arrows.forEach(a => a.addEventListener('click', () =>
      rowEl.scrollBy({ left: Number(a.dataset.dir) * rowEl.clientWidth * 0.7, behavior: 'smooth' })));
    rowEl.addEventListener('scroll', updateArrows, { passive: true });

    function render(clips, keepIndex) {
      st.clips = clips;
      rowEl.innerHTML = '';
      clips.forEach((clip, i) => {
        const b = document.createElement('button');
        b.setAttribute('aria-label', `${clip.time} 的片段`);
        const img = document.createElement('img');
        img.src = 'assets/s-flower.png';
        img.alt = '';
        b.appendChild(img);
        b.addEventListener('click', () => select(i));
        rowEl.appendChild(b);
      });
      if (clips.length) {
        select(keepIndex !== undefined
          ? Math.max(0, Math.min(keepIndex, clips.length - 1))
          : clips.length - 1);
      } else {
        clear();
      }
      setTimeout(updateArrows, 50);
    }

    async function select(i) {
      const clip = st.clips[i];
      if (!clip) return;
      const myToken = ++st.token;   // 快速連點時，只認最後一次
      st.index = i;

      rowEl.querySelectorAll('button').forEach((b, j) => b.classList.toggle('active', j === i));
      /* 只捲花朵列本身（水平），不要用 scrollIntoView，否則整頁會跟著往上跳 */
      const btn = rowEl.children[i];
      if (btn) {
        const target = btn.offsetLeft - (rowEl.clientWidth - btn.offsetWidth) / 2;
        rowEl.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
      }
      $(ids.time).textContent = clip.time;
      $(ids.sub).textContent = (clip.subtitle || '').trim();
      $(ids.stage).hidden = false;

      const back = 1 - st.cur;         // 背後那個 video
      const bv = vs[back];
      const url = URL.createObjectURL(clip.videoBlob);
      if (urls[back]) URL.revokeObjectURL(urls[back]);
      urls[back] = url;
      bv.src = url;
      bv.muted = vs[st.cur].muted;

      /* 等它真的有畫面了才切過去（不然會看到一瞬間的黑） */
      await new Promise(res => {
        if (bv.readyState >= 2) return res();
        bv.addEventListener('loadeddata', res, { once: true });
        setTimeout(res, 1200);
      });
      if (myToken !== st.token) return;   // 期間又切了別段，這次作廢

      bv.currentTime = 0;
      await bv.play().catch(() => {});
      if (myToken !== st.token) return;

      bv.classList.add('on');
      vs[st.cur].classList.remove('on');
      vs[st.cur].pause();
      st.cur = back;
    }

    vs.forEach(v => {
      v.addEventListener('click', () => {
        const cv = video();
        const nowMuted = !cv.muted;
        vs.forEach(x => { x.muted = nowMuted; });
        if (cv.paused) cv.play().catch(() => {});
      });
      /* 播完自動輪到下一朵花；編輯字幕期間(hold)原地重播同一段 */
      v.addEventListener('ended', () => {
        if (v !== video()) return;              // 只理會正在顯示的那個
        if (st.index < 0 || !st.clips.length) return;
        if (st.hold || st.clips.length === 1) {
          v.currentTime = 0;
          v.play().catch(() => {});
          return;
        }
        select((st.index + 1) % st.clips.length);
      });
    });
    $(ids.more).addEventListener('click', () => {
      const clip = st.clips[st.index];
      if (clip) openClipMenu(clip, st.index, getRefresh(), stageApi);
    });

    const stageApi = {
      render, clear,
      pause: () => video().pause(),
      /* 編輯字幕期間定住在同一段：不暫停影片（暫停後 iOS 常拒絕恢復播放而卡住/變黑），
         只停掉自動換段，讓它原地重播 */
      hold() { st.hold = true; },
      release() { st.hold = false; },
      /* 只換畫面上的字幕文字，不重載影片（避免黑屏）；
         並從頭重播這一段，讓使用者確實看到剛打的字幕才輪到下一段 */
      setSubText(text) {
        if (st.index >= 0 && st.clips[st.index]) st.clips[st.index].subtitle = text;
        $(ids.sub).textContent = (text || '').trim();
        const v = video();
        v.currentTime = 0;
        v.play().catch(() => {});
      },
      get index() { return st.index; },
    };
    return stageApi;
  }

  const todayStage = createStage(
    { row: 'flower-row', stage: 'clip-stage', video: 'stage-video', videoB: 'stage-video-b',
      time: 'stage-time', sub: 'stage-sub', more: 'stage-more' },
    () => (ki) => renderToday(ki)
  );
  const dayStage = createStage(
    { row: 'day-flower-row', stage: 'day-clip-stage', video: 'day-stage-video', videoB: 'day-stage-video-b',
      time: 'day-stage-time', sub: 'day-stage-sub', more: 'day-stage-more' },
    () => (ki) => openDay(dayDate, ki)
  );

  /* ---------- 今天 ---------- */
  async function renderToday(keepIndex) {
    const ds = todayStr();
    const clips = (await DB.clipsByDate(ds)).sort(byTime);
    const d = new Date();
    $('stamp-num').textContent = d.getDate();
    $('stamp-month').textContent = `${d.getMonth() + 1} 月・週${WEEK[d.getDay()]}`;
    $('stamp-count').textContent = clips.length ? `${clips.length} 段回憶` : '還沒有片段';
    $('today-empty').hidden = clips.length > 0;
    await setSaveButtonLabel($('btn-generate'), ds, clips, '今日');
    todayStage.render(clips, keepIndex);
  }

  /* ---------- 全螢幕播放 ---------- */
  let playerUrl = null;
  function playBlob(blob) {
    const v = $('player-video');
    playerUrl = URL.createObjectURL(blob);
    v.src = playerUrl;
    $('player').hidden = false;
    v.play().catch(() => {});
  }
  $('player-close').addEventListener('click', closePlayer);
  $('player').addEventListener('click', e => { if (e.target === $('player')) closePlayer(); });
  function closePlayer() {
    const v = $('player-video');
    v.pause(); v.removeAttribute('src'); v.load();
    if (playerUrl) { URL.revokeObjectURL(playerUrl); playerUrl = null; }
    $('player').hidden = true;
  }

  /* ---------- 片段選單 ---------- */
  let menuCtx = null;
  function openClipMenu(clip, index, refresh, stage) {
    menuCtx = { clip, index, refresh, stage };
    $('clip-menu').hidden = false;
  }
  $('menu-cancel').addEventListener('click', () => { $('clip-menu').hidden = true; });
  $('clip-menu').addEventListener('click', e => { if (e.target === $('clip-menu')) $('clip-menu').hidden = true; });
  $('menu-edit').addEventListener('click', () => {
    $('clip-menu').hidden = true;
    editSubtitle(menuCtx.clip, menuCtx.refresh, menuCtx.index, menuCtx.stage);
  });
  $('menu-save').addEventListener('click', async () => {
    $('clip-menu').hidden = true;
    const c = menuCtx.clip;
    await shareOrDownload(c.videoBlob, `奶球vlog_${c.date}_${c.time.replace(':', '')}.${Encode.fileExt()}`);
  });
  $('menu-delete').addEventListener('click', async () => {
    $('clip-menu').hidden = true;
    const { clip, index, refresh } = menuCtx;
    const ok = await confirmDialog(`刪除 ${clip.time} 的片段？`, '刪除');
    if (!ok) return;
    await DB.deleteClip(clip.id);
    refresh(index > 0 ? index - 1 : 0); updateCamHead();
    toast('已刪除', '復原', async () => {
      await DB.putClip(clip);
      refresh(index); updateCamHead();
    }, 5000);
  });

  /* ---------- 儲存影片到手機 ----------
     Android／電腦：直接下載存檔。
     iPhone：網頁無法直接寫入相簿，分享面板的「儲存影片」是唯一路徑，
     所以 iOS 才走分享（面板第一項通常就是儲存影片）。 */
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                 (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  async function shareOrDownload(blob, filename) {
    if (IS_IOS) {
      const file = new File([blob], filename, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file] }); return; }
        catch (e) { if (e.name === 'AbortError') return; }
      }
    }
    download(blob, filename);
    toast('已儲存到手機');
  }

  /* ---------- 匯入 ---------- */
  let trimFile = null;
  let trimUrl = null;
  let importTargetDate = null;   // 匯入要進到哪一天（今天頁＝今天，日頁＝該日）
  let lastImportInfo = '';       // 診斷：這次剪片用了哪個引擎、花多久
  $('btn-import').addEventListener('click', () => {
    importTargetDate = todayStr();
    $('import-input').click();
  });
  $('btn-day-import').addEventListener('click', () => {
    importTargetDate = dayDate;
    $('import-input').click();
  });
  let videoQueue = [];   // 一次選多支影片時，逐支排隊裁切
  $('import-input').addEventListener('change', async () => {
    const files = Array.from($('import-input').files || []);
    $('import-input').value = '';
    if (!files.length) return;
    const images = files.filter(f => (f.type || '').startsWith('image/'));
    const videos = files.filter(f => (f.type || '').startsWith('video/'));
    /* 照片先批次加入（定格 2 秒），影片再逐支開裁切介面 */
    if (images.length) await importPhotos(images);
    if (videos.length) { videoQueue = videos.slice(); nextInVideoQueue(); }
  });
  function nextInVideoQueue() {
    const f = videoQueue.shift();
    if (f) openTrimForFile(f);
  }
  function openTrimForFile(f) {
    trimFile = f;
    /* 大影片從相簿讀進來要一點時間，先給回饋，不要讓人乾等一個轉圈 */
    showGenOverlay('讀取影片中…');
    $('gen-cancel').hidden = true;
    const v = $('trim-video');
    trimUrl = URL.createObjectURL(f);
    v.src = trimUrl;
    v.onloadedmetadata = () => {
      hideGenOverlay();
      $('gen-cancel').hidden = false;
      const max = Math.max(0, v.duration - 2);
      const r = $('trim-range');
      r.max = max.toFixed(1);
      r.value = 0;
      $('trim-sheet').hidden = false;
      loopPreview();
      v.play().catch(() => {});
    };
    v.onerror = () => {
      hideGenOverlay();
      $('gen-cancel').hidden = false;
      toast('這支影片打不開，換一支試試');
      cleanupTrim();
      nextInVideoQueue();   // 這支壞了就換下一支
    };
  }

  /* 照片匯入：一張照片 → 定格 2 秒的片段，和影片片段一視同仁排進那天 */
  async function importPhotos(images) {
    if (!Encode2.canImportPhoto || !Encode2.canImportPhoto()) {
      toast('這台裝置無法匯入照片');
      return;
    }
    Encode.getAudioCtx();
    const target = importTargetDate || todayStr();
    const cancel = { on: false };
    genCancelToken = cancel;
    let added = 0, lastClip = null;
    for (let i = 0; i < images.length; i++) {
      if (cancel.on) break;
      showGenOverlay(images.length > 1 ? `加入照片 第 ${i + 1}／${images.length}…` : '加入這張照片…');
      try {
        const out = await Encode2.imageToClip(images[i], cancel);
        if (!out) continue;
        const now = new Date();
        const shot = new Date(images[i].lastModified);
        const clip = {
          id: crypto.randomUUID(),
          date: target,
          time: timeStrOf(isNaN(shot) ? now : shot),   // 時間用照片本身的時間
          createdAt: now.getTime(),
          subtitle: '',
          videoBlob: out.blob,
          thumbBlob: out.thumbBlob,
          source: 'photo',
        };
        await DB.putClip(clip);
        added++; lastClip = clip;
      } catch (e) {
        console.warn('照片匯入失敗', e);
      }
    }
    hideGenOverlay();
    if (!added) { toast('照片加入失敗，換一張試試'); return; }
    updateCamHead();
    const onDay = currentTab === 'day';
    const stage = onDay ? dayStage : (currentTab === 'today' ? todayStage : undefined);
    if (onDay) await openDay(target);
    else if (currentTab === 'today') renderToday();
    if (added === 1 && lastClip) {
      toast('已加入 1 張照片', '補一句話', () => editSubtitle(lastClip, undefined, undefined, stage));
    } else {
      toast(`已加入 ${added} 張照片`);
    }
  }
  const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  function loopPreview() {
    const v = $('trim-video');
    const start = parseFloat($('trim-range').value);
    $('trim-range-label').textContent = `${mmss(start)} → ${mmss(start + 2)}`;
    v.currentTime = start;
    v.ontimeupdate = () => { if (v.currentTime - start >= 2) v.currentTime = start; };
  }
  $('trim-range').addEventListener('input', loopPreview);
  $('trim-cancel').addEventListener('click', () => { videoQueue = []; cleanupTrim(); });   // 取消＝中止整批
  function cleanupTrim() {
    const v = $('trim-video');
    v.pause(); v.ontimeupdate = null; v.removeAttribute('src'); v.load();
    if (trimUrl) { URL.revokeObjectURL(trimUrl); trimUrl = null; }
    trimFile = null;
    $('trim-sheet').hidden = true;
  }
  $('trim-ok').addEventListener('click', async () => {
    const file = trimFile;
    const start = parseFloat($('trim-range').value);
    cleanupTrim();
    if (!file) return;
    Encode.getAudioCtx();
    showGenOverlay('剪出這 2 秒…');
    const cancel = { on: false };
    genCancelToken = cancel;
    const tStart = Date.now();
    let usedFast = false;
    let failReason = '';
    try {
      /* 三層剪片，由快到穩（與合成同一套策略）：
         快速 WebCodecs → 混合 <video>+WebCodecs → 可靠即時錄 */
      let out = null;
      const fastBroken = localStorage.getItem('nq-fast-broken') === '1';
      const hybridBroken = localStorage.getItem('nq-hybrid-broken') === '1';
      if (!fastBroken && Encode2.supported()) {
        try {
          out = await Encode2.trimSegment(file, start, cancel);
          usedFast = !!out;
          if (!out) failReason = '快速引擎沒有產出';
        } catch (e) {
          failReason = String(e && e.message || e).slice(0, 60);
          console.warn('快速裁切失敗，改用混合引擎：', e);
          localStorage.setItem('nq-fast-broken', '1');
          out = null;
        }
      } else if (fastBroken) {
        failReason = '快速引擎此裝置停用';
      } else {
        failReason = '此裝置不支援 WebCodecs';
      }
      /* 第二層：混合引擎（iPhone 主力，畫面順、無停頓） */
      if (!out && !cancel.on && !hybridBroken && typeof file !== 'undefined' &&
          (file.type || '').includes('mp4') && Encode2.canUseHybrid([{ videoBlob: file }])) {
        try {
          out = await Encode2.trimSegmentHybrid(file, start, cancel);
          usedFast = !!out;
        } catch (e) {
          console.warn('混合裁切失敗，改用可靠引擎：', e);
          localStorage.setItem('nq-hybrid-broken', '1');
          out = null;
        }
      }
      /* 第三層：可靠引擎保底 */
      if (!out && !cancel.on) out = await Encode.trimSegment(file, start, cancel);
      hideGenOverlay();
      if (!out) return;
      const secs = ((Date.now() - tStart) / 1000).toFixed(1);
      lastImportInfo = usedFast
        ? `快速剪片 ${secs}s`
        : `一般剪片 ${secs}s（${failReason}）`;
      const now = new Date();
      const target = importTargetDate || todayStr();
      const shot = new Date(file.lastModified);
      const clip = {
        id: crypto.randomUUID(),
        date: target,                       // 在哪一天的頁面匯入，就進到那一天
        time: timeStrOf(isNaN(shot) ? now : shot),   // 時間用影片本身的拍攝時間
        createdAt: now.getTime(),
        subtitle: '',
        videoBlob: out.blob,
        thumbBlob: out.thumbBlob,
        source: 'import',
      };
      await DB.putClip(clip);
      updateCamHead();
      const onDay = currentTab === 'day';
      const stage = onDay ? dayStage : (currentTab === 'today' ? todayStage : undefined);
      if (onDay) await openDay(target);
      else if (currentTab === 'today') renderToday();
      /* 交給舞台原地改字，不重繪（否則影片會黑一下） */
      toast(`已匯入・${lastImportInfo}`, '補一句話', () => editSubtitle(clip, undefined, undefined, stage));
    } catch (e) {
      hideGenOverlay();
      toast('匯入失敗，換一支影片試試');
    } finally {
      nextInVideoQueue();   // 一次選多支時，接著剪下一支
    }
  });

  /* ---------- 影片方向（直式／橫式，記住選擇） ---------- */
  function getOrient() {
    return localStorage.getItem('nq-orient') === 'landscape' ? 'landscape' : 'portrait';
  }
  /* 切直式／橫式時，舞台即時變成成品的比例（先看到會長怎樣再儲存） */
  function syncOrientUI() {
    const land = getOrient() === 'landscape';
    document.querySelectorAll('.orient-toggle button').forEach(b =>
      b.classList.toggle('active', b.dataset.orient === getOrient()));
    document.querySelectorAll('.clip-stage').forEach(el =>
      el.classList.toggle('landscape', land));
  }
  document.querySelectorAll('.orient-toggle button').forEach(b =>
    b.addEventListener('click', () => {
      localStorage.setItem('nq-orient', b.dataset.orient);
      syncOrientUI();
      refreshSaveButtons();
    }));
  syncOrientUI();

  /* ---------- 生成 ---------- */
  let genCancelToken = null;
  let genResult = null;

  function showGenOverlay(msg) {
    $('gen-status').textContent = msg;
    $('gen-status').hidden = false;
    $('gen-cancel').hidden = false;
    $('gen-done').hidden = true;
    $('gen-bar-fill').style.width = '0%';
    $('gen-overlay').hidden = false;
  }
  function hideGenOverlay() { $('gen-overlay').hidden = true; }
  $('gen-cancel').addEventListener('click', () => {
    if (genCancelToken) genCancelToken.on = true;
    hideGenOverlay();
  });

  /* 成品的「內容指紋」：片段、字幕、方向任一有變，才需要重新合成 */
  function dailySig(clips, orient) {
    /* 版本號放進指紋：合成引擎一改版，舊成品的指紋就對不上 → 強制重新合成。
       否則片段沒變時 App 會直接把上次存好的舊影片給你，新修的東西永遠跑不到。 */
    return `v${APP_VER}#` + clips.map(c => `${c.id}:${(c.subtitle || '').trim()}`).join('|') + '#' + orient;
  }

  /* 按鈕文字要說實話：現成的就寫「直接存」，有變動才寫「合成並儲存」 */
  async function setSaveButtonLabel(btn, dateStr, clips, whose) {
    if (!clips.length) {
      btn.disabled = true;
      btn.textContent = whose === '今日' ? '今天還沒有片段' : '這天還沒有片段';
      return;
    }
    btn.disabled = false;
    const daily = await DB.getDaily(dateStr);
    const ready = daily && daily.sig === dailySig(clips, getOrient()) && daily.videoBlob;
    btn.textContent = ready
      ? `儲存${whose} Vlog（${daily.duration} 秒・已合成）`
      : `合成並儲存${whose} Vlog（${clips.length} 段・${clips.length * 2} 秒）`;
    /* 已合成時才露出「重新合成一次」：讓她不用改字幕就能重跑一遍 */
    const regen = $(btn.id === 'btn-generate' ? 'btn-regen' : 'btn-day-regen');
    if (regen) regen.hidden = !ready;
  }

  /* 只更新按鈕文字，不重繪舞台（重繪會讓影片重載變黑） */
  async function refreshSaveButtons() {
    if (currentTab === 'today') {
      const ds = todayStr();
      await setSaveButtonLabel($('btn-generate'), ds, (await DB.clipsByDate(ds)).sort(byTime), '今日');
    } else if (currentTab === 'day' && dayDate) {
      await setSaveButtonLabel($('btn-day-generate'), dayDate, (await DB.clipsByDate(dayDate)).sort(byTime), '這天的');
    }
  }

  async function generateFor(dateStr, force = false) {
    const clips = (await DB.clipsByDate(dateStr)).sort(byTime);
    if (!clips.length) { toast('這天沒有片段可以合成'); return; }

    /* 已經合成過、而且內容沒變 → 直接存，不再跑一次合成。
       force＝true（按「重新合成一次」）就跳過這條捷徑，重新做一支。 */
    const existing = await DB.getDaily(dateStr);
    const sig = dailySig(clips, getOrient());
    if (!force && existing && existing.sig === sig && existing.videoBlob) {
      genResult = { blob: existing.videoBlob, dateStr };
      try {
        await shareOrDownload(existing.videoBlob, `奶球vlog_${dateStr}.${Encode.fileExt()}`);
      } catch (e) {
        /* iOS 偶爾會擋掉非直接手勢的分享 → 退回用大按鈕讓使用者再按一次 */
        showGenOverlay('');
        $('gen-status').hidden = true;
        $('gen-cancel').hidden = true;
        $('gen-done-msg').textContent = `已經合成好了・${existing.duration} 秒`;
        $('gen-done').hidden = false;
      }
      return;
    }

    Encode.getAudioCtx(); // 手勢裡解鎖
    let wakeLock = null;
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) {}

    showGenOverlay(`正在合成 第 1／${clips.length} 段…`);
    const cancel = { on: false };
    genCancelToken = cancel;
    try {
      /* 三層引擎，由快到穩：
         1. 快速（WebCodecs 全硬體）— Chrome/Android 用，最快
         2. 混合（<video> 解碼 + WebCodecs 編碼）— iPhone 用，畫面順、無接縫凍結
         3. 可靠（MediaRecorder 即時錄）— 最後保底，一定成功但接縫會頓一下
         某一層在這台裝置壞過就記起來，下次直接跳過、不再讓使用者看到失敗 */
      const fastBroken = localStorage.getItem('nq-fast-broken') === '1';
      const hybridBroken = localStorage.getItem('nq-hybrid-broken') === '1';
      let fast = !fastBroken && Encode2.canUse(clips);
      const onProgress = (i, n) => {
        $('gen-status').textContent = `合成 第 ${i}／${n} 段…`;
        $('gen-bar-fill').style.width = `${Math.round((i / n) * 100)}%`;
      };
      let blob = null;
      if (fast) {
        try {
          blob = await Encode2.composeDaily(clips, labelOf(dateStr), onProgress, cancel, getOrient());
        } catch (e) {
          console.warn('快速引擎失敗，改用混合引擎：', e);
          localStorage.setItem('nq-fast-broken', '1');
          blob = null;
        }
      }
      /* 第二層：混合引擎（iPhone 主力）*/
      if (!blob && !cancel.on && !hybridBroken && Encode2.canUseHybrid(clips)) {
        try {
          blob = await Encode2.composeDailyHybrid(clips, labelOf(dateStr), onProgress, cancel, getOrient());
        } catch (e) {
          console.warn('混合引擎失敗，改用可靠引擎：', e);
          localStorage.setItem('nq-hybrid-broken', '1');
          blob = null;
        }
      }
      /* 第三層：可靠引擎保底 */
      if (!blob && !cancel.on) {
        $('gen-status').textContent = '合成中…';
        blob = await Encode.composeDaily(clips, labelOf(dateStr), onProgress, cancel, getOrient());
      }
      if (!blob || cancel.on) { hideGenOverlay(); return; }
      await DB.putDaily({
        date: dateStr, videoBlob: blob, duration: clips.length * 2,
        sig, orient: getOrient(), generatedAt: Date.now(),
      });
      genResult = { blob, dateStr };
      $('gen-status').hidden = true;
      $('gen-cancel').hidden = true;
      $('gen-done-msg').textContent = `完成！${clips.length * 2} 秒的一天`;
      $('gen-done').hidden = false;
      refreshSaveButtons();   // 已經合成好了：按鈕改成「直接存」
      if (views.day.classList.contains('active')) openDay(dateStr);
    } catch (e) {
      console.error(e);
      $('gen-status').textContent = '合成失敗了，回到清單再試一次';
      $('gen-cancel').textContent = '關閉';
      setTimeout(() => { $('gen-cancel').textContent = '取消'; }, 6000);
    } finally {
      try { wakeLock && wakeLock.release(); } catch (e) {}
    }
  }

  $('btn-generate').addEventListener('click', () => generateFor(todayStr()));
  $('btn-regen').addEventListener('click', () => generateFor(todayStr(), true));
  $('btn-save-album').addEventListener('click', async () => {
    if (genResult) await shareOrDownload(genResult.blob, `奶球vlog_${genResult.dateStr}.${Encode.fileExt()}`);
    hideGenOverlay();   // 存完就回到原本的頁面
  });
  $('gen-close').addEventListener('click', hideGenOverlay);

  /* ---------- 月曆 ---------- */
  let calYear, calMonth; // month: 0-11
  function initCalToNow() { const d = new Date(); calYear = d.getFullYear(); calMonth = d.getMonth(); }

  async function renderCalendar() {
    if (calYear === undefined) initCalToNow();
    $('cal-title').textContent = `${calYear} 年 ${calMonth + 1} 月`;
    const grid = $('cal-grid');
    grid.querySelectorAll('img').forEach(i => URL.revokeObjectURL(i.src));
    grid.innerHTML = '';
    const first = new Date(calYear, calMonth, 1);
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const lead = (first.getDay() + 6) % 7; // 週一開頭
    const today = todayStr();
    const allDates = new Set(await DB.allClipDates());
    for (let i = 0; i < lead; i++) grid.appendChild(document.createElement('div'));
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${calYear}-${pad(calMonth + 1)}-${pad(d)}`;
      const cell = document.createElement('button');
      cell.className = 'cal-day';
      cell.textContent = d;
      cell.setAttribute('aria-label', `${calMonth + 1} 月 ${d} 日`);
      if (ds === today) cell.classList.add('today');
      if (ds > today) cell.classList.add('future');
      if (allDates.has(ds)) {
        cell.classList.add('has-clip');
        DB.clipsByDate(ds).then(clips => {
          const c = clips.sort(byTime)[0];
          if (c && c.thumbBlob) {
            const img = document.createElement('img');
            img.src = URL.createObjectURL(c.thumbBlob);
            img.alt = '';
            cell.appendChild(img);
          }
        });
      }
      if (ds <= today) cell.addEventListener('click', () => openDay(ds));
      grid.appendChild(cell);
    }
  }

  $('cal-prev').addEventListener('click', () => {
    calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; }
    renderCalendar();
  });
  $('cal-next').addEventListener('click', () => {
    calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; }
    renderCalendar();
  });

  /* ---------- 日頁 ---------- */
  let dayDate = null;
  let diaryTimer = null;

  async function openDay(ds, keepIndex) {
    dayDate = ds;
    showView('day');
    $('day-title').textContent = `${labelOf(ds)}（${weekdayOf(ds)}）`;   // 短格式，標題列才不會擠到換行
    $('day-next').disabled = addDays(ds, 1) > todayStr();

    const clips = (await DB.clipsByDate(ds)).sort(byTime);
    $('day-nostrip').hidden = clips.length > 0;
    await setSaveButtonLabel($('btn-day-generate'), ds, clips, '這天的');
    dayStage.render(clips, keepIndex);

    const diary = await DB.getDiary(ds);
    $('diary-text').value = diary ? diary.text : '';
    $('diary-saved').textContent = '';
    autoGrowDiary();
  }

  $('day-back').addEventListener('click', () => switchTab('diary'));
  $('btn-day-generate').addEventListener('click', () => generateFor(dayDate));
  $('btn-day-regen').addEventListener('click', () => generateFor(dayDate, true));

  /* 上一天／下一天 */
  function addDays(ds, n) {
    const d = new Date(ds + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return dateStrOf(d);
  }
  $('day-prev').addEventListener('click', () => openDay(addDays(dayDate, -1)));
  $('day-next').addEventListener('click', () => {
    const next = addDays(dayDate, 1);
    if (next <= todayStr()) openDay(next);
  });

  /* 日記隨字數自動長高，不會被蓋住。
     +6：box-sizing 是 border-box，scrollHeight 不含邊框，不補會切掉最後一行 */
  function autoGrowDiary() {
    const t = $('diary-text');
    t.style.height = 'auto';
    t.style.height = `${Math.max(170, t.scrollHeight + 6)}px`;
  }

  $('diary-text').addEventListener('input', () => {
    autoGrowDiary();
    clearTimeout(diaryTimer);
    diaryTimer = setTimeout(async () => {
      await DB.putDiary({ date: dayDate, text: $('diary-text').value, updatedAt: Date.now() });
      $('diary-saved').textContent = `已自動儲存 ${timeStrOf(new Date())}`;
    }, 800);
  });

  /* ---------- 給我意見（送到 Discord） ---------- */
  const FEEDBACK_WEBHOOK = 'https://discord.com/api/webhooks/1484231558637289625/RlRRgUUq_UmKrVzBV6lcfxY1XfLjV--1mj6hfopSocXbvpHJYHxPTdMOVfaqmYq1RJKX';
  $('btn-feedback').addEventListener('click', () => {
    $('feedback-sheet').hidden = false;
    setTimeout(() => $('fb-text').focus(), 100);
  });
  $('fb-cancel').addEventListener('click', () => { $('feedback-sheet').hidden = true; });
  $('feedback-sheet').addEventListener('click', e => {
    if (e.target === $('feedback-sheet')) $('feedback-sheet').hidden = true;
  });
  $('fb-send').addEventListener('click', async () => {
    const text = $('fb-text').value.trim();
    if (!text) { toast('先寫點什麼再送出吧'); return; }
    const name = $('fb-name').value.trim() || '朋友';
    const btn = $('fb-send');
    btn.disabled = true;
    btn.textContent = '送出中…';
    try {
      const res = await fetch(FEEDBACK_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `【奶球 Vlog 意見】${name}：\n${text}` }),
      });
      if (!res.ok) throw new Error(res.status);
      $('fb-text').value = '';
      $('feedback-sheet').hidden = true;
      toast('已送出，謝謝你的意見！');
    } catch (e) {
      toast('送出失敗了，檢查網路再試一次');
    } finally {
      btn.disabled = false;
      btn.textContent = '送出';
    }
  });

  /* ---------- 首次使用提示 ---------- */
  if (!localStorage.getItem('nq-firstrun')) {
    $('firstrun').hidden = false;
    $('firstrun-ok').addEventListener('click', () => {
      localStorage.setItem('nq-firstrun', '1');
      $('firstrun').hidden = true;
    });
  }

  /* App 切到背景（或關閉）時放掉相機／麥克風：
     不然 iOS 會一直亮紅點，關 app 時音訊被硬切還會「逼」一聲 */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCamera();
    else if (currentTab === 'capture') ensureCamera();
  });
  window.addEventListener('pagehide', stopCamera);

  /* ---------- 啟動 ---------- */
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  /* 自動更新：
     1) sw.js 帶版本號 + updateViaCache:'none' → iPhone 不會拿它 10 分鐘前的舊副本來比對
        （以前就是卡在這：一上線就測，手機根本還沒發現有新版）
     2) 每次開 App 主動問一次有沒有新版，有的話裝好就直接接手
     3) 新版接手的瞬間自動重新整理一次 → 不用再「關掉兩次」 */
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });
    navigator.serviceWorker.register(`sw.js?v=${APP_VER}`, { updateViaCache: 'none' })
      .then(reg => {
        const nudge = () => { if (reg.waiting) reg.waiting.postMessage('SKIP_WAITING'); };
        nudge();
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (sw) sw.addEventListener('statechange', () => { if (sw.state === 'installed') nudge(); });
        });
        reg.update().catch(() => {});
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden) reg.update().catch(() => {});
        });
      })
      .catch(() => {});
  }
  updateCamHead();
  ensureCamera();
})();
