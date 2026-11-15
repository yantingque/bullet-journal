import { meetingKinds } from './model.mjs';

function waitForMedia(player, event, signal, action) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const timeout = setTimeout(stop, 12000);
    function stop() {
      finish(false);
    }
    function loaded() {
      finish(true);
    }
    function finish(ok) {
      clearTimeout(timeout);
      player.removeEventListener(event, loaded);
      player.removeEventListener('error', stop);
      signal.removeEventListener('abort', stop);
      resolve(ok);
    }
    signal.addEventListener('abort', stop, { once: true });
    player.addEventListener(event, loaded, { once: true });
    player.addEventListener('error', stop, { once: true });
    try {
      action?.();
    } catch {
      stop();
    }
  });
}

function isWebm(file, filename = file.name ?? '') {
  return /\.webm$/i.test(filename) || /^(audio|video)\/webm\b/i.test(file.type);
}

async function prepareWebmPlayback(player, signal) {
  if (player.readyState === 0 && !await waitForMedia(player, 'loadedmetadata', signal)) return;
  if (signal.aborted || Number.isFinite(player.duration)) return;

  const position = player.currentTime;
  // Live WebM lacks a duration header. Reaching EOF resolves the real player's timeline.
  await waitForMedia(player, 'seeked', signal, () => { player.currentTime = Number.MAX_SAFE_INTEGER; });
  if (!signal.aborted && (player.seeking || player.currentTime !== position)) {
    await waitForMedia(player, 'seeked', signal, () => { player.currentTime = position; });
  }
}

const audioLimit = 100 * 1024 * 1024;
const recordingLimit = 90 * 60 * 1000;
const transcriptChunkSize = 8000;

function splitTranscript(text) {
  const chunks = [];
  while (text.length > transcriptChunkSize) {
    const newline = text.lastIndexOf('\n', transcriptChunkSize);
    const end = newline >= transcriptChunkSize / 2 ? newline + 1 : transcriptChunkSize;
    chunks.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text) chunks.push(text);
  return chunks.map(chunk => chunk.trim()).filter(Boolean);
}

export function createMeetingEditor({ request, uuid, today, model, refresh }) {
  const dialog = document.querySelector('#meeting-editor');
  const form = dialog.querySelector('form');
  const fields = form.elements;
  const find = name => dialog.querySelector('#meeting-' + name);
  const screen = find('screen');
  const mic = find('mic');
  const mix = find('mix');
  const stop = find('stop');
  const elapsed = find('elapsed');
  const file = find('file');
  const player = find('player');
  const playbackStatus = find('playback-status');
  const download = find('download');
  const transcribe = find('transcribe');
  const cancelTranscribe = find('cancel-transcribe');
  const transcriptionStatus = find('transcription-status');
  const transcriptionTime = find('transcription-time');
  const transcriptionProgress = find('transcription-progress');
  const deviceSelect = find('device');
  const summaryProgress = find('summary-progress');
  const summarize = find('summarize');
  const remove = find('delete');
  const status = find('status');
  const savedFields = ['title', 'date', 'notes', 'transcript', 'meetingKind'];
  for (const [id, kind] of Object.entries(meetingKinds)) {
    fields.meetingKind.add(new Option(kind.label, id));
  }
  function updateSummaryHint() {
    fields.notes.placeholder = meetingKinds[fields.meetingKind.value].sections;
  }
  fields.meetingKind.addEventListener('change', updateSummaryHint);
  function renderOverview() {
    const overview = find('overview');
    const content = find('overview-content');
    const notes = fields.notes.value.trim();
    overview.hidden = !notes;
    content.replaceChildren();
    if (!notes) return;
    for (const part of notes.split(/(?=^#{1,6}\s+)/m)) {
      const heading = part.match(/^#{1,6}\s+([^\n]+)/);
      if (heading) {
        const title = document.createElement('h3');
        title.textContent = heading[1];
        content.append(title);
      }
      const body = document.createElement('p');
      body.textContent = part.slice(heading?.[0].length || 0).trim().replace(/\*\*([^*]+)\*\*/g, '$1');
      if (body.textContent) content.append(body);
    }
  }
  fields.notes.addEventListener('input', renderOverview);
  let item;
  let opening = false;
  let busy = false;
  let capture;
  let transcription;
  let blob;
  let audioUrl;
  let playbackPreparation;
  let recorded = false;
  const hasMic = Boolean(window.MediaRecorder && window.AudioContext && navigator.mediaDevices?.getUserMedia);
  const hasScreen = Boolean(window.MediaRecorder && window.AudioContext && navigator.mediaDevices?.getDisplayMedia);
  screen.hidden = find('mix-label').hidden = !hasScreen;
  mic.hidden = !hasMic;
  if (!hasScreen) find('capture-help').textContent = hasMic
    ? '錄音前請告知與會者。線上會議音訊請用電腦瀏覽器錄製。'
    : '這個瀏覽器無法直接錄音。你仍可匯入錄音或貼上逐字稿。';

  function refreshControls() {
    const recording = Boolean(capture);
    for (const control of [screen, mic, mix, file, summarize, transcribe, remove, deviceSelect, fields.meetingKind, fields.title, fields.date,
      fields.transcript, fields.notes, form.querySelector('[type=submit]'), find('close')]) {
      control.disabled = busy || recording;
    }
    summarize.disabled ||= !fields.transcript.value.trim();
    transcribe.disabled ||= !blob;
    stop.hidden = elapsed.hidden = !capture?.recorder;
    stop.disabled = capture?.recorder?.state === 'inactive';
  }

  function showPlaybackStatus() {
    if (playbackPreparation) {
      playbackStatus.hidden = false;
      playbackStatus.textContent = '正在準備錄音時間軸…';
    } else if (blob && Number.isFinite(player.duration) && player.duration > 0) {
      const seconds = Math.round(player.duration);
      const time = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
        .map(unit => String(unit).padStart(2, '0')).join(':');
      playbackStatus.hidden = false;
      playbackStatus.textContent = '錄音總長度 ' + time;
    } else {
      playbackStatus.hidden = true;
    }
  }
  player.addEventListener('durationchange', showPlaybackStatus);

  function setAudio(audio, name = '', localRecording = false) {
    playbackPreparation?.abort();
    playbackPreparation = undefined;
    transcriptionStatus.textContent = '';
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    player.removeAttribute('src');
    download.removeAttribute('href');
    player.load();
    player.controls = true;
    blob = audio;
    recorded = localRecording;
    audioUrl = audio ? URL.createObjectURL(audio) : '';
    if (audio) {
      player.src = download.href = audioUrl;
      download.download = name || ('會議錄音-' + fields.date.value + (audio.type.includes('mp4') ? '.m4a' : '.webm'));
      if (isWebm(audio, name)) {
        const preparing = new AbortController();
        playbackPreparation = preparing;
        player.controls = false;
        void prepareWebmPlayback(player, preparing.signal).then(() => {
          if (preparing.signal.aborted) return;
          playbackPreparation = undefined;
          player.controls = true;
          showPlaybackStatus();
        });
      }
    }
    showPlaybackStatus();
    find('audio').hidden = !audio;
    refreshControls();
  }

  function release(session) {
    clearInterval(session.timer);
    for (const stream of session.streams) for (const track of stream.getTracks()) track.stop();
    void session.context?.close().catch(() => {});
    capture = undefined;
    refreshControls();
  }

  function finish(session, message = '') {
    if (capture !== session || session.recorder?.state !== 'recording') return;
    session.message = message;
    session.recorder.stop();
    refreshControls();
  }

  async function startCapture(source) {
    if (busy || capture) return;
    if (recorded && !confirm('開始新的錄音會取代目前的音檔。確定繼續？')) return;
    const session = { streams: [], chunks: [], bytes: 0 };
    capture = session;
    refreshControls();
    status.textContent = '等待瀏覽器的音訊授權…';
    try {
      const context = session.context = new AudioContext();
      const resumed = context.resume().then(() => true, () => false);
      // The display picker must be called directly from the button gesture.
      if (source === 'screen') {
        const display = await navigator.mediaDevices.getDisplayMedia({
          video: true, audio: { suppressLocalAudioPlayback: false },
          selfBrowserSurface: 'exclude', systemAudio: 'include'
        });
        session.streams.push(display);
        if (!display.getAudioTracks().some(track => track.readyState === 'live')) {
          throw new Error('選取的來源沒有音訊。請選會議分頁並勾選分享音訊。');
        }
      }
      if (source === 'mic' || mix.checked) {
        const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
        session.streams.push(microphone);
      }
      if (!await resumed) throw new Error('無法開啟瀏覽器的音訊處理。請再試一次。');
      const destination = context.createMediaStreamDestination();
      const sources = session.streams.flatMap(stream => stream.getAudioTracks()).filter(track => track.readyState === 'live');
      if (!sources.length || session.streams.some(stream => !stream.getAudioTracks().some(track => track.readyState === 'live'))) {
        throw new Error('音訊分享已結束，請重新開始錄音。');
      }
      for (const track of sources) {
        context.createMediaStreamSource(new MediaStream([track])).connect(destination);
      }
      const recorder = session.recorder = new MediaRecorder(destination.stream, { audioBitsPerSecond: 48000 });
      recorder.ondataavailable = ({ data }) => {
        if (!data.size) return;
        session.chunks.push(data);
        session.bytes += data.size;
        if (session.bytes >= audioLimit * .95) finish(session, '已接近轉錄容量上限，錄音已停止。');
      };
      recorder.onerror = () => { session.message = '錄音意外中斷，請先檢查已錄片段。'; };
      recorder.onstop = () => {
        if (capture !== session) return;
        const audio = new Blob(session.chunks, { type: recorder.mimeType });
        release(session);
        if (audio.size) {
          setAudio(audio, '', true);
          file.value = '';
        }
        status.textContent = session.message || (audio.size ? '錄音已完成，可以播放、下載或轉成逐字稿。' : '沒有錄到音訊。');
      };
      for (const track of session.streams.flatMap(stream => stream.getTracks())) {
        track.addEventListener('ended', () => finish(session, '音訊來源已停止，已保留錄到的片段。'), { once: true });
      }
      recorder.start(1000);
      const start = Date.now();
      elapsed.textContent = '00:00';
      session.timer = setInterval(() => {
        const duration = Date.now() - start;
        const seconds = Math.floor(duration / 1000);
        elapsed.textContent = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
        if (duration >= recordingLimit) finish(session, '已錄滿 90 分鐘。可先下載此段，再開始下一段。');
      }, 1000);
      status.textContent = source === 'screen' ? '正在錄製分享音訊' + (mix.checked ? '與麥克風。' : '。') : '正在錄製麥克風。';
      refreshControls();
    } catch (error) {
      release(session);
      status.textContent = error.name === 'NotAllowedError'
        ? '未取得錄音權限。請重新授權；若只需對方的聲音，可取消勾選麥克風。' : error.message;
    }
  }

  screen.onclick = () => startCapture('screen');
  mic.onclick = () => startCapture('mic');
  stop.onclick = () => { if (capture) finish(capture); };
  file.onchange = () => {
    const selected = file.files[0];
    if (!selected) return;
    if (selected.size > audioLimit || !selected.size) {
      status.textContent = '請選擇有內容且不超過 100 MB 的錄音。';
      file.value = '';
      return;
    }
    if (recorded && !confirm('匯入音檔會取代目前的錄音。確定繼續？')) {
      file.value = '';
      return;
    }
    setAudio(selected, selected.name);
    status.textContent = '錄音已載入。';
  };

  async function withBusy(operation) {
    if (busy || capture) return;
    busy = true;
    refreshControls();
    try {
      await operation();
    } catch (error) {
      status.textContent = error.message || '操作暫時無法完成。';
    } finally {
      busy = false;
      refreshControls();
    }
  }

  cancelTranscribe.onclick = () => transcription?.abort();
  transcribe.onclick = () => withBusy(async () => {
    if (!blob) return;
    if (fields.transcript.value.trim() && !confirm('要用轉錄結果取代目前的逐字稿嗎？')) return;
    status.textContent = '';
    cancelTranscribe.hidden = transcriptionTime.hidden = transcriptionProgress.hidden = false;
    transcriptionProgress.removeAttribute('value');
    transcribe.textContent = '轉錄處理中…';
    const start = Date.now();
    let percent;
    const updateTime = () => {
      const seconds = Math.floor((Date.now() - start) / 1000);
      const progress = percent === undefined ? '' : `約 ${percent}% · `;
      transcriptionTime.textContent = progress + `已等待 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);
    try {
      const result = await new Promise((resolve, reject) => {
        const upload = transcription = new XMLHttpRequest();
        upload.open('POST', '/api/meeting-audio?progress=1&device=' + encodeURIComponent(deviceSelect.value));
        let cursor = 0;
        let result;
        const parseEvents = () => {
          if (!upload.getResponseHeader('Content-Type')?.includes('application/x-ndjson')) return;
          const text = upload.responseText;
          let newline;
          while ((newline = text.indexOf('\n', cursor)) !== -1) {
            const event = JSON.parse(text.slice(cursor, newline));
            cursor = newline + 1;
            const device = { cuda: 'GPU', cpu: 'CPU' }[event.device];
            const message = {
              reading: '正在讀取錄音並確認長度…',
              loading: `Whisper 正在載入模型（${device}）…`,
              transcribing: `Whisper 正用 ${device} 轉錄…`,
              fallback: 'GPU 無法使用，正在切換到 CPU…'
            }[event.stage];
            if (message) {
              if (transcriptionStatus.textContent !== message) transcriptionStatus.textContent = message;
              percent = Number.isFinite(event.percent) ? event.percent : undefined;
              if (percent === undefined) transcriptionProgress.removeAttribute('value');
              else transcriptionProgress.value = percent;
              updateTime();
            } else result = event;
          }
        };
        upload.onprogress = parseEvents;
        transcriptionStatus.textContent = '正在傳送錄音到子彈筆記服務…';
        upload.upload.onload = () => {
          transcriptionStatus.textContent = '已送出錄音，正在等待本地模型的轉錄結果。';
        };
        upload.onload = () => {
          try {
            parseEvents();
            if (!cursor) result = JSON.parse(upload.responseText);
            if (typeof result?.transcript === 'string' && upload.status >= 200 && upload.status < 300) resolve(result);
            else reject(new Error(result?.error || '未能取得轉錄結果，請重試。'));
          } catch {
            reject(new Error('未能讀取轉錄結果，請重試。'));
          }
        };
        upload.onerror = () => reject(new Error('與子彈筆記服務的連線中斷，請重試。'));
        upload.onabort = () => reject(new DOMException('已取消轉錄，錄音仍可播放或下載。', 'AbortError'));
        upload.send(blob);
      });
      fields.transcript.value = result.transcript;
      const device = { gpu: 'GPU', cpu: 'CPU' }[result.device];
      transcriptionStatus.textContent = '逐字稿已產生。' + (device ? `本次使用 ${device}。` : '') +
        '可修改辨識結果，再按「本地 AI 整理」。';
    } catch (error) {
      transcriptionStatus.textContent = error.message;
    } finally {
      clearInterval(timer);
      transcription = undefined;
      cancelTranscribe.hidden = transcriptionTime.hidden = transcriptionProgress.hidden = true;
      transcribe.textContent = '轉成逐字稿';
    }
  });

  summarize.onclick = () => withBusy(async () => {
    if (fields.notes.value.trim() && !confirm('要用新的整理結果取代目前的摘要嗎？')) return;
    const modelLabel = model() || 'Ollama';
    const meetingKind = fields.meetingKind.value;
    summaryProgress.hidden = false;
    try {
      let input = fields.transcript.value.trim();
      while (input.length > 9000) {
        const chunks = splitTranscript(input);
        const parts = [];
        summaryProgress.max = chunks.length;
        summaryProgress.value = 0;
        for (const [index, text] of chunks.entries()) {
          status.textContent = `${modelLabel} 正在整理第 ${index + 1} / ${chunks.length} 段…`;
          const result = await request('local-ai', { mode: 'meeting-part', text, meetingKind });
          parts.push(result.text.slice(0, 1400));
          summaryProgress.value = index + 1;
        }
        input = parts.join('\n\n');
      }
      summaryProgress.removeAttribute('value');
      status.textContent = `${modelLabel} 正在整理${meetingKinds[meetingKind].label}紀錄…`;
      const result = await request('local-ai', { mode: 'meeting', text: input, meetingKind });
      fields.notes.value = result.text;
      renderOverview();
      status.textContent = '整理完成。可核對內容後儲存。';
    } finally {
      summaryProgress.hidden = true;
    }
  });

  fields.transcript.addEventListener('input', refreshControls);
  function changed() {
    return savedFields.some(name => fields[name].value !== item[name]);
  }

  function cancel(event) {
    if (busy || capture || ((recorded || changed()) && !confirm('離開會捨棄尚未儲存的修改及未下載的錄音。確定離開？'))) {
      event?.preventDefault();
      return;
    }
    if (!event) dialog.close();
  }

  find('close').onclick = () => cancel();
  dialog.addEventListener('cancel', cancel);
  dialog.addEventListener('close', () => setAudio());
  window.addEventListener('beforeunload', event => {
    if (!dialog.open || !(capture || busy || recorded || changed())) return;
    event.preventDefault();
    event.returnValue = '';
  });

  form.onsubmit = event => {
    event.preventDefault();
    void withBusy(async () => {
      if (!fields.title.value.trim()) {
        status.textContent = '請填寫會議名稱。';
        return;
      }
      if (recorded && !confirm('儲存並關閉後，這次的錄音會從視窗清除。確定繼續？')) return;
      const values = Object.fromEntries(savedFields.map(name => [name, fields[name].value]));
      await request('meeting', { id: item.id, version: item.version, ...values });
      dialog.close();
      await refresh();
    });
  };
  remove.onclick = () => withBusy(async () => {
    if (!confirm('將這筆會議紀錄移到垃圾桶？')) return;
    await request('trash', { id: item.id, version: item.version, category: 'item', deleted: true });
    dialog.close();
    await refresh();
  });

  return async (id, meetingKind = 'meeting') => {
    if (opening || dialog.open) return;
    opening = true;
    try {
      item = id ? await request('meeting?id=' + encodeURIComponent(id)) :
        { id: uuid(), version: 0, title: '', date: today(), transcript: '', notes: '', meetingKind };
      item.meetingKind ??= 'meeting';
      for (const name of savedFields) fields[name].value = item[name];
      updateSummaryHint();
      renderOverview();
      deviceSelect.value = 'auto';
      remove.hidden = !id;
      file.value = '';
      status.textContent = '';
      setAudio();
      dialog.showModal();
      fields.title.focus();
    } finally {
      opening = false;
    }
  };
}
