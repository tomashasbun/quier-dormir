const videoElement = document.getElementById('video');
const canvasElement = document.getElementById('canvas');
const canvasCtx = canvasElement.getContext('2d');

const angleValueElement = document.getElementById('angle-value');
const statusTextElement = document.getElementById('status-text');
const pathologyTextElement = document.getElementById('pathology-text');
const angleCard = document.getElementById('angle-card');
const scaleMarker = document.getElementById('scale-marker');
const romValueElement = document.getElementById('rom-value');
const maxValueElement = document.getElementById('max-value');
const minValueElement = document.getElementById('min-value');
const legValueElement = document.getElementById('leg-value');
const stageEmpty = document.getElementById('stage-empty');
const stageResolution = document.getElementById('stage-resolution');
const trackingStatus = document.getElementById('tracking-status');
const recordingLabel = document.getElementById('recording-label');
const sourceBadge = document.getElementById('source-badge');
const sourceLabel = document.getElementById('source-label');
const liveChip = document.getElementById('live-chip');
const sessionClock = document.getElementById('session-clock');
const sampleCount = document.getElementById('sample-count');
const chartEmpty = document.getElementById('chart-empty');
const captureNote = document.getElementById('capture-note');

const startCameraButton = document.getElementById('start-camera-btn');
const stopButton = document.getElementById('stop-btn');
const resetButton = document.getElementById('reset-btn');
const uploadInput = document.getElementById('video-upload');
const legSelect = document.getElementById('leg-select');

const state = {
  mode: 'idle', // idle | camera | file
  stream: null,
  fileUrl: null,
  animationFrameId: null,
  processing: false,
  lastVideoTime: -1,
  lastChartUpdate: 0,
  startTime: null,
  clockTimer: null,
  sampleTimes: [],
  angles: [],
  minAngle: Infinity,
  maxAngle: -Infinity,
  smoothedAngle: null,
  lastLeg: '--',
  poseReady: false,
};

const MAX_CHART_POINTS = 180;
const CHART_INTERVAL_MS = 180;

function formatAngle(value, decimals = 1) {
  if (!Number.isFinite(value)) return '--';
  const rounded = Number(value.toFixed(decimals));
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}

function calculateAngle(a, b, c) {
  // Calcula el ángulo ABC usando el producto punto de BA y BC.
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const dotProduct = (v1.x * v2.x) + (v1.y * v2.y);
  const mag1 = Math.hypot(v1.x, v1.y);
  const mag2 = Math.hypot(v2.x, v2.y);

  if (mag1 < 1e-6 || mag2 < 1e-6) return null;
  const cosine = Math.max(-1, Math.min(1, dotProduct / (mag1 * mag2)));
  const angleRadians = Math.acos(cosine);
  return angleRadians * (180 / Math.PI);
}

function getLandmarkSet(landmarks) {
  const left = {
    side: 'Izquierda',
    knee: landmarks[25],
    ankle: landmarks[27],
    foot: landmarks[31],
  };
  const right = {
    side: 'Derecha',
    knee: landmarks[26],
    ankle: landmarks[28],
    foot: landmarks[32],
  };

  const selectedSide = legSelect.value;
  if (selectedSide === 'left') return left;
  if (selectedSide === 'right') return right;

  // En modo automático se elige el conjunto con mayor visibilidad media.
  const visibilityScore = (set) => {
    const values = [set.knee, set.ankle, set.foot];
    if (values.some((point) => !point)) return 0;
    return values.reduce((sum, point) => sum + (point.visibility ?? 0), 0) / values.length;
  };
  return visibilityScore(left) >= visibilityScore(right) ? left : right;
}

function isLandmarkVisible(point) {
  return Boolean(point) && (point.visibility ?? 0) >= 0.55;
}

function setTrackingState(detected, message) {
  trackingStatus.classList.toggle('detected', detected);
  trackingStatus.innerHTML = `<span class="tracking-dot"></span> ${message}`;
}

function resizeCanvasToImage(image) {
  const width = image.videoWidth || image.width || 640;
  const height = image.videoHeight || image.height || 480;
  if (canvasElement.width !== width || canvasElement.height !== height) {
    canvasElement.width = width;
    canvasElement.height = height;
    stageResolution.textContent = `${width} × ${height}`;
  }
}

function drawSkeleton(knee, ankle, foot) {
  const width = canvasElement.width;
  const height = canvasElement.height;
  const points = [knee, ankle, foot];

  canvasCtx.save();
  canvasCtx.lineCap = 'round';
  canvasCtx.lineJoin = 'round';
  canvasCtx.beginPath();
  canvasCtx.moveTo(knee.x * width, knee.y * height);
  canvasCtx.lineTo(ankle.x * width, ankle.y * height);
  canvasCtx.lineTo(foot.x * width, foot.y * height);
  canvasCtx.strokeStyle = '#69e0cd';
  canvasCtx.lineWidth = Math.max(3, width * 0.004);
  canvasCtx.shadowColor = 'rgba(74, 218, 201, .5)';
  canvasCtx.shadowBlur = 12;
  canvasCtx.stroke();
  canvasCtx.shadowBlur = 0;

  points.forEach((point, index) => {
    canvasCtx.beginPath();
    canvasCtx.arc(point.x * width, point.y * height, Math.max(5, width * 0.007), 0, Math.PI * 2);
    canvasCtx.fillStyle = index === 1 ? '#ffbe69' : '#55d8a6';
    canvasCtx.fill();
    canvasCtx.lineWidth = 2;
    canvasCtx.strokeStyle = '#071522';
    canvasCtx.stroke();
  });
  canvasCtx.restore();
}

function classifyAngle(angle) {
  if (angle > 20) {
    return {
      label: 'Dorsiflexión sobre referencia',
      description: 'El valor supera el límite superior configurado (+20°). Interpreta el resultado junto con la evaluación clínica.',
      className: 'warning',
    };
  }
  if (angle < -25) {
    return {
      label: 'Flexión plantar sobre referencia',
      description: 'El valor está por debajo del límite inferior configurado (−25°). Revisa la técnica y la posición de la cámara.',
      className: 'danger',
    };
  }
  if (angle >= 0) {
    return {
      label: 'Dorsiflexión en referencia',
      description: 'La medición está dentro del rango de referencia configurado para dorsiflexión.',
      className: 'normal',
    };
  }
  return {
    label: 'Flexión plantar en referencia',
    description: 'La medición está dentro del rango de referencia configurado para flexión plantar.',
    className: 'normal',
  };
}

function updateAngleUI(angle, legSide) {
  angleValueElement.textContent = formatAngle(angle, 1);
  const classification = classifyAngle(angle);
  statusTextElement.textContent = classification.label;
  pathologyTextElement.textContent = classification.description;
  angleCard.classList.remove('warning', 'danger');
  if (classification.className !== 'normal') angleCard.classList.add(classification.className);
  legValueElement.textContent = legSide;

  // Escala visual limitada a -40° ... +40°.
  const normalized = Math.max(0, Math.min(100, ((angle + 40) / 80) * 100));
  scaleMarker.style.left = `${normalized}%`;
}

function updateMetrics() {
  if (state.angles.length === 0) {
    romValueElement.innerHTML = '--<small>°</small>';
    maxValueElement.innerHTML = '--<small>°</small>';
    minValueElement.innerHTML = '--<small>°</small>';
    sampleCount.textContent = '0 muestras';
    return;
  }
  const rom = state.maxAngle - state.minAngle;
  romValueElement.innerHTML = `${rom.toFixed(1)}<small>°</small>`;
  maxValueElement.innerHTML = `${formatAngle(state.maxAngle, 1)}<small>°</small>`;
  minValueElement.innerHTML = `${formatAngle(state.minAngle, 1)}<small>°</small>`;
  sampleCount.textContent = `${state.angles.length} muestras`;
}

function updateSessionClock() {
  if (!state.startTime) {
    sessionClock.textContent = '00:00';
    return;
  }
  const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
  const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const seconds = String(elapsed % 60).padStart(2, '0');
  sessionClock.textContent = `${minutes}:${seconds}`;
}

function startClock() {
  if (!state.startTime) state.startTime = Date.now();
  if (state.clockTimer) clearInterval(state.clockTimer);
  state.clockTimer = setInterval(updateSessionClock, 500);
  updateSessionClock();
}

function stopClock() {
  if (state.clockTimer) clearInterval(state.clockTimer);
  state.clockTimer = null;
}

function updateChart(angle, timestamp) {
  const elapsedSeconds = Math.max(0, (timestamp - state.startTime) / 1000);
  const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
  const seconds = String(Math.floor(elapsedSeconds % 60)).padStart(2, '0');
  const label = `${minutes}:${seconds}`;

  romChart.data.labels.push(label);
  romChart.data.datasets[0].data.push(Number(angle.toFixed(2)));
  romChart.data.datasets[1].data.push(0);
  romChart.data.datasets[2].data.push(20);
  romChart.data.datasets[3].data.push(-25);

  if (romChart.data.labels.length > MAX_CHART_POINTS) {
    romChart.data.labels.shift();
    romChart.data.datasets.forEach((dataset) => dataset.data.shift());
  }
  romChart.update('none');
  chartEmpty.classList.add('hidden');
}

function recordAngle(angle, legSide) {
  // Suavizado exponencial ligero para reducir pequeños saltos de los landmarks.
  state.smoothedAngle = state.smoothedAngle === null
    ? angle
    : (state.smoothedAngle * 0.72) + (angle * 0.28);
  const stableAngle = state.smoothedAngle;

  state.angles.push(stableAngle);
  state.minAngle = Math.min(state.minAngle, stableAngle);
  state.maxAngle = Math.max(state.maxAngle, stableAngle);
  state.lastLeg = legSide;

  updateAngleUI(stableAngle, legSide);
  updateMetrics();

  const now = performance.now();
  if (now - state.lastChartUpdate >= CHART_INTERVAL_MS) {
    updateChart(stableAngle, Date.now());
    state.lastChartUpdate = now;
  }
}

function onPoseResults(results) {
  const image = results.image;
  if (!image) return;

  resizeCanvasToImage(image);
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  canvasCtx.drawImage(image, 0, 0, canvasElement.width, canvasElement.height);
  stageEmpty.hidden = true;

  const landmarks = results.poseLandmarks;
  if (!landmarks) {
    setTrackingState(false, 'No se detecta la pierna');
    angleValueElement.textContent = '--';
    statusTextElement.textContent = 'Esperando puntos de referencia';
    pathologyTextElement.textContent = 'Mantén la rodilla, el tobillo y el pie visibles en la imagen.';
    return;
  }

  const selected = getLandmarkSet(landmarks);
  const { knee, ankle, foot, side } = selected;
  if (![knee, ankle, foot].every(isLandmarkVisible)) {
    setTrackingState(false, 'Ajusta el encuadre');
    angleValueElement.textContent = '--';
    statusTextElement.textContent = 'Hitos no detectados';
    pathologyTextElement.textContent = 'Se necesita visualizar rodilla, tobillo y punta del pie. Prueba con una vista lateral más despejada.';
    return;
  }

  const internalAngle = calculateAngle(knee, ankle, foot);
  if (internalAngle === null || !Number.isFinite(internalAngle)) {
    setTrackingState(false, 'No se pudo calcular');
    return;
  }

  // Convención usada en esta interfaz: 90° internos equivale a 0° neutro.
  const clinicalAngle = 90 - internalAngle;
  drawSkeleton(knee, ankle, foot);
  setTrackingState(true, `Pierna ${side.toLowerCase()} detectada`);
  recordAngle(clinicalAngle, side);
}

function setCaptureUI(mode) {
  const active = mode !== 'idle';
  state.mode = mode;
  stopButton.disabled = !active;
  startCameraButton.disabled = mode === 'camera';
  liveChip.classList.toggle('active', active);
  liveChip.textContent = active ? 'ANALIZANDO' : 'INACTIVO';
  recordingLabel.classList.toggle('active', active);
  recordingLabel.innerHTML = active
    ? '<span class="recording-dot"></span> ANALIZANDO'
    : '<span class="recording-dot"></span> EN ESPERA';
  sourceBadge.classList.toggle('active', active);
  sourceLabel.textContent = mode === 'camera' ? 'Webcam' : mode === 'file' ? 'Video cargado' : 'Sin señal';
}

function startProcessingLoop() {
  cancelAnimationFrame(state.animationFrameId);
  state.lastVideoTime = -1;

  const process = async () => {
    if (state.mode === 'idle') return;
    if (videoElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        videoElement.videoWidth > 0 &&
        videoElement.currentTime !== state.lastVideoTime &&
        !state.processing) {
      state.processing = true;
      state.lastVideoTime = videoElement.currentTime;
      try {
        await pose.send({ image: videoElement });
      } catch (error) {
        console.error('Error procesando el cuadro con MediaPipe:', error);
        captureNote.textContent = 'No se pudo procesar un cuadro. Comprueba que el video tenga un formato compatible.';
      } finally {
        state.processing = false;
      }
    }
    if (state.mode !== 'idle') state.animationFrameId = requestAnimationFrame(process);
  };

  state.animationFrameId = requestAnimationFrame(process);
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert('Tu navegador no permite acceder a la cámara. Abre la aplicación mediante HTTPS o desde localhost.');
    return;
  }

  stopCapture(false);
  resetMeasurements();
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    videoElement.srcObject = state.stream;
    videoElement.loop = true;
    await videoElement.play();
    canvasElement.classList.add('mirrored');
    setCaptureUI('camera');
    startClock();
    setTrackingState(false, 'Buscando pierna');
    captureNote.textContent = 'Webcam activa. Coloca la pierna de perfil y mantén rodilla, tobillo y pie dentro del encuadre.';
    startProcessingLoop();
  } catch (error) {
    console.error('No se pudo iniciar la webcam:', error);
    stopCapture(false);
    let message = 'No se pudo iniciar la cámara.';
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      message = 'Permite el acceso a la cámara desde los permisos del navegador y vuelve a intentarlo.';
    } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      message = 'No se encontró una cámara conectada al dispositivo.';
    }
    captureNote.textContent = message;
    alert(message);
  }
}

async function loadVideo(file) {
  if (!file) return;
  if (!file.type.startsWith('video/')) {
    alert('Selecciona un archivo de video válido.');
    uploadInput.value = '';
    return;
  }

  stopCapture(false);
  resetMeasurements();
  if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
  state.fileUrl = URL.createObjectURL(file);
  videoElement.srcObject = null;
  videoElement.src = state.fileUrl;
  videoElement.loop = true;
  videoElement.muted = true;
  canvasElement.classList.remove('mirrored');

  try {
    await new Promise((resolve, reject) => {
      videoElement.onloadedmetadata = resolve;
      videoElement.onerror = () => reject(new Error('No se pudo abrir el archivo de video.'));
    });
    await videoElement.play();
    setCaptureUI('file');
    startClock();
    setTrackingState(false, 'Procesando video');
    captureNote.textContent = `Analizando: ${file.name}. El video se reproduce en bucle para facilitar la observación.`;
    startProcessingLoop();
  } catch (error) {
    console.error('Error al cargar el video:', error);
    stopCapture(false);
    captureNote.textContent = 'No fue posible reproducir este video. Prueba con MP4, WebM o MOV.';
    alert('No fue posible reproducir este video. Prueba con un archivo MP4 o WebM.');
  }
}

function stopCapture(clearSource = true) {
  state.mode = 'idle';
  cancelAnimationFrame(state.animationFrameId);
  state.animationFrameId = null;
  state.lastVideoTime = -1;
  state.processing = false;

  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
  videoElement.pause();
  if (clearSource) {
    videoElement.srcObject = null;
    videoElement.removeAttribute('src');
    videoElement.load();
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    canvasElement.width = 640;
    canvasElement.height = 360;
    stageResolution.textContent = '-- × --';
    stageEmpty.hidden = false;
    canvasElement.classList.remove('mirrored');
  }

  setCaptureUI('idle');
  stopClock();
  setTrackingState(false, 'Captura detenida');
  updateSessionClock();
}

function resetMeasurements() {
  state.sampleTimes = [];
  state.angles = [];
  state.minAngle = Infinity;
  state.maxAngle = -Infinity;
  state.smoothedAngle = null;
  state.lastLeg = '--';
  state.lastChartUpdate = 0;
  state.startTime = state.mode === 'idle' ? null : Date.now();

  romChart.data.labels = [];
  romChart.data.datasets.forEach((dataset) => { dataset.data = []; });
  romChart.update('none');
  chartEmpty.classList.remove('hidden');

  angleValueElement.textContent = '--';
  statusTextElement.textContent = 'Esperando medición';
  pathologyTextElement.textContent = 'Inicia la captura y coloca la pierna de perfil frente a la cámara.';
  angleCard.classList.remove('warning', 'danger');
  legValueElement.textContent = '--';
  scaleMarker.style.left = '55.5%';
  updateMetrics();
  updateSessionClock();
  if (state.mode !== 'idle') startClock();
}

// Gráfico de ROM: línea de ángulo y referencias clínicas horizontales.
const chartContext = document.getElementById('rom-chart').getContext('2d');
const chartGradient = chartContext.createLinearGradient(0, 0, 0, 250);
chartGradient.addColorStop(0, 'rgba(85, 198, 235, .22)');
chartGradient.addColorStop(1, 'rgba(85, 198, 235, 0)');

const romChart = new Chart(chartContext, {
  type: 'line',
  data: {
    labels: [],
    datasets: [
      {
        label: 'Ángulo medido', data: [], borderColor: '#55c6eb', backgroundColor: chartGradient,
        borderWidth: 2.2, fill: true, tension: 0.28, pointRadius: 0, pointHitRadius: 8,
      },
      {
        label: 'Neutro (0°)', data: [], borderColor: 'rgba(173, 192, 213, .65)',
        borderWidth: 1, borderDash: [5, 5], pointRadius: 0, fill: false,
      },
      {
        label: 'Límite +20°', data: [], borderColor: 'rgba(224, 177, 107, .8)',
        borderWidth: 1, borderDash: [2, 5], pointRadius: 0, fill: false,
      },
      {
        label: 'Límite −25°', data: [], borderColor: 'rgba(224, 177, 107, .8)',
        borderWidth: 1, borderDash: [2, 5], pointRadius: 0, fill: false,
      },
    ],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { intersect: false, mode: 'index' },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#0b1727',
        borderColor: 'rgba(144, 177, 211, .2)',
        borderWidth: 1,
        titleColor: '#dceafa',
        bodyColor: '#9db4ce',
        padding: 10,
        callbacks: {
          label: (context) => `${context.dataset.label}: ${Number(context.parsed.y).toFixed(1)}°`,
        },
      },
    },
    scales: {
      x: {
        grid: { color: 'rgba(145, 169, 197, .07)', drawTicks: false },
        border: { display: false },
        ticks: { color: '#748ba6', maxTicksLimit: 7, maxRotation: 0, font: { family: 'DM Sans', size: 9 } },
      },
      y: {
        min: -45,
        max: 45,
        grid: { color: 'rgba(145, 169, 197, .09)', drawTicks: false },
        border: { display: false },
        ticks: { stepSize: 15, color: '#748ba6', padding: 8, font: { family: 'DM Sans', size: 9 }, callback: (value) => `${value}°` },
      },
    },
  },
});

// Inicializa MediaPipe una sola vez.
const pose = new Pose({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
});
pose.setOptions({
  modelComplexity: 1,
  smoothLandmarks: true,
  enableSegmentation: false,
  minDetectionConfidence: 0.55,
  minTrackingConfidence: 0.55,
});
pose.onResults(onPoseResults);

startCameraButton.addEventListener('click', startCamera);
stopButton.addEventListener('click', () => stopCapture(true));
resetButton.addEventListener('click', resetMeasurements);
uploadInput.addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  loadVideo(file);
  // Permite volver a seleccionar el mismo archivo más adelante.
  uploadInput.value = '';
});
legSelect.addEventListener('change', () => {
  resetMeasurements();
  if (state.mode !== 'idle') {
    captureNote.textContent = `Extremidad seleccionada: ${legSelect.options[legSelect.selectedIndex].text}. Se reinició el registro para no mezclar mediciones de ambas piernas.`;
  }
});

window.addEventListener('beforeunload', () => {
  stopCapture(false);
  resetMeasurements();
  if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
});

// Estado inicial del panel.
setCaptureUI('idle');
setTrackingState(false, 'Esperando sujeto');
updateMetrics();
