const clamp = value => Math.max(0, Math.min(1, value));
const tau = Math.PI * 2;
const smooth = value => { const x = clamp(value); return x * x * (3 - 2 * x); };
const syllables = [[0.55,0.78,0.36],[0.84,1.13,0.82],[1.18,1.39,0.34],[1.45,1.72,0.6],[1.94,2.17,0.32],[2.22,2.51,0.68],[2.56,2.83,0.46],[3.52,3.8,0.76],[3.86,4.07,0.34],[4.16,4.46,0.64],[4.52,4.75,0.31],[4.84,5.17,0.7]];

// Feed this function a Web Audio time-domain buffer, or an offline audio envelope.
export function speechLevel(samples) {
  let power = 0;
  for (const sample of samples) power += sample * sample;
  return clamp((Math.sqrt(power / samples.length) - 0.012) * 7);
}

// A deterministic looping demonstration. Audio callers supply their own mouthOpen.
export function demoSpeech(time) {
  const phase = ((time % 6) + 6) % 6;
  for (const [start, end, peak] of syllables) {
    if (phase >= start && phase < end) {
      const progress = (phase - start) / (end - start);
      return peak * smooth(progress < 0.3 ? progress / 0.3 : (1 - progress) / 0.7);
    }
  }
  return 0;
}

function blinkFrame(phase) {
  for (const start of [1.08, 4.57]) {
    const elapsed = phase - start;
    if (elapsed >= 0 && elapsed < 0.27) return elapsed < 0.04 ? 1 : elapsed < 0.08 ? 2 : elapsed < 0.15 ? 3 : elapsed < 0.21 ? 2 : 1;
  }
  return 0;
}

// Keep the cut along the cheek/chin silhouette; the complete neck plate stays behind it.
function jawCurve(context, jaw) {
  for (let i = 0; i < jaw.length - 2; i += 2) {
    context.quadraticCurveTo(jaw[i], jaw[i + 1], (jaw[i] + jaw[i + 2]) / 2, (jaw[i + 1] + jaw[i + 3]) / 2);
  }
  context.lineTo(jaw.at(-2), jaw.at(-1));
}

function headPath(context, jaw) {
  context.beginPath(); context.moveTo(0, 0); context.lineTo(256, 0);
  context.lineTo(256, 164);
  if (jaw) {
    context.lineTo(jaw[0], jaw[1]); jawCurve(context, jaw);
  } else {
    context.lineTo(176, 164);
    context.bezierCurveTo(164, 181, 143, 189, 128, 189);
    context.bezierCurveTo(113, 189, 92, 181, 80, 164);
  }
  context.lineTo(0, 164); context.closePath();
}

// Restore the fine warm outline after removing the original dark backing.
function drawJawOutline(context, jaw) {
  let start = 0, end = jaw.length;
  while (start < end && jaw[start + 1] <= 164) start += 2;
  while (end > start && jaw[end - 1] <= 164) end -= 2;
  jaw = jaw.slice(start, end);
  context.save(); context.strokeStyle = '#9b5b49'; context.lineWidth = 0.8;
  context.lineJoin = 'round'; context.lineCap = 'round'; context.beginPath();
  context.moveTo(jaw[0], jaw[1]);
  jawCurve(context, jaw);
  context.stroke(); context.restore();
}

// Accents stay in portrait space so they remain readable beside the hair.
export function drawExpressionAccent(context, expression, { eyes = [[96, 136], [154, 136]], time = 0 } = {}) {
  context.save(); context.lineCap = 'round'; context.lineJoin = 'round';
  if (expression === 'puzzled' || expression === 'surprised') {
    context.translate(221, 42); context.rotate(expression === 'puzzled' ? 0.14 : -0.16);
    const mark = () => {
      context.beginPath();
      if (expression === 'puzzled') {
        context.moveTo(-10, -12);
        context.bezierCurveTo(-11, -25, 13, -25, 13, -12);
        context.bezierCurveTo(13, -3, 1, -3, 0, 7);
      } else {
        context.moveTo(-1, -20); context.bezierCurveTo(0, -12, 0, -4, 0, 7);
      }
      context.stroke();
      context.beginPath(); context.ellipse(-0.5, 19, 3.5, 3.1, 0.2, 0, tau); context.fill();
    };
    context.strokeStyle = context.fillStyle = '#fff5e6'; context.lineWidth = 10; mark();
    const ink = context.createLinearGradient(0, -22, 0, 22);
    ink.addColorStop(0, expression === 'puzzled' ? '#76588d' : '#d59a38');
    ink.addColorStop(1, expression === 'puzzled' ? '#4e365f' : '#9b5e22');
    context.strokeStyle = context.fillStyle = ink; context.lineWidth = 6; mark();
    context.lineWidth = 1.8;
    context.beginPath(); context.moveTo(-21, -15); context.lineTo(-25, -19);
    context.moveTo(21, -10); context.lineTo(25, -13); context.stroke();
  } else if (expression === 'angry') {
    context.strokeStyle = '#fffaf0'; context.lineWidth = 8;
    const anger = () => {
      context.beginPath();
      for (const [x, y, dx, dy] of [[216,32,-10,-10],[226,32,10,-10],[216,42,-10,10],[226,42,10,10]]) {
        context.moveTo(x, y + dy); context.lineTo(x, y); context.lineTo(x + dx, y);
      }
      context.stroke();
    };
    anger(); context.strokeStyle = '#d6463c'; context.lineWidth = 4.5; anger();
  } else if (expression === 'excited') {
    for (const [x, y, radius] of [[220,32,18],[239,63,10]]) {
      context.beginPath(); context.moveTo(x, y - radius);
      context.lineTo(x + radius * 0.3, y - radius * 0.3); context.lineTo(x + radius, y);
      context.lineTo(x + radius * 0.3, y + radius * 0.3); context.lineTo(x, y + radius);
      context.lineTo(x - radius * 0.3, y + radius * 0.3); context.lineTo(x - radius, y);
      context.lineTo(x - radius * 0.3, y - radius * 0.3); context.closePath();
      context.strokeStyle = '#fffaf0'; context.lineWidth = 4; context.stroke();
      context.fillStyle = '#edab22'; context.fill();
    }
  } else if (expression === 'crying') {
    for (let side = 0; side < eyes.length; side++) {
      const [x, y] = eyes[side], outward = side === 0 ? -1 : 1;
      context.save(); context.translate(x, y); context.scale(outward, 1);
      const tear = context.createLinearGradient(-7, 0, 7, 45);
      tear.addColorStop(0, '#bce5efdf'); tear.addColorStop(0.65, '#87c7debf'); tear.addColorStop(1, '#5fabc582');
      context.fillStyle = tear; context.strokeStyle = '#669bb58c'; context.lineWidth = 0.6;
      context.beginPath(); context.moveTo(-7, 1);
      context.bezierCurveTo(-5, 13, -4, 25, -2, 39);
      context.bezierCurveTo(0, 47, 6, 48, 10, 42);
      context.bezierCurveTo(12, 31, 8, 15, 8, 1);
      context.quadraticCurveTo(1, 4, -7, 1); context.closePath(); context.fill(); context.stroke();
      context.clip();
      context.strokeStyle = '#f0fbffbd'; context.lineWidth = 1.4;
      context.beginPath(); context.moveTo(6, 6); context.bezierCurveTo(6, 20, 9, 31, 7, 41); context.stroke();
      // Short highlights travel down the continuous tear stream.
      const flow = ((time * 0.65 + side * 0.3) % 1 + 1) % 1;
      for (const offset of [0, 0.5]) {
        const height = 6 + ((flow + offset) % 1) * 34;
        context.beginPath(); context.moveTo(0, height); context.lineTo(0.6, height + 4); context.stroke();
      }
      context.restore();
    }
  }
  context.restore();
}

export function drawPersonalIP(context, images, rig, {
  time = 0, x = 0, y = 0, size = 256, speaking = false,
  mouthOpen = speaking ? demoSpeech(time) : 0,
  roundness, bodySource, bodyDestination = [0, 0, rig.width, rig.height],
  blink = true, motion = true, facial = true, pixelStep = 0, headTilt = 0, expression = 'neutral', cleanJaw = false,
} = {}) {
  const phase = ((time % rig.period) + rig.period) % rig.period;
  const breath = motion ? (1 - Math.cos(tau * phase / rig.period)) / 2 : 0;
  const snap = value => pixelStep ? Math.round(value / pixelStep) * pixelStep : value;
  const torsoLift = snap(breath * 1.05), headLift = snap(breath * 0.18);
  context.save();
  context.translate(x, y); context.scale(size / rig.width, size / rig.height);
  context.save();
  context.translate(0, 256); context.scale(1, 1 + torsoLift / 78); context.translate(0, -256);
  if (bodySource) context.drawImage(images.body, ...bodySource, ...bodyDestination);
  else context.drawImage(images.body, 0, 0, rig.width, rig.height);
  context.restore();
  // Every facial layer uses the head's local space, including optional deliberate tilts.
  context.save();
  const [pivotX, pivotY] = rig.head.pivot;
  context.translate(pivotX, pivotY - headLift);
  if (headTilt) context.rotate(headTilt * Math.PI / 180);
  context.translate(-pivotX, -pivotY);
  const jaw = cleanJaw ? rig.wardrobeJaws?.front : undefined;
  context.save(); headPath(context, jaw); context.clip();
  context.drawImage(images.base, 0, 0, rig.width, rig.height);
  if (facial) {
    const layerIds = rig.layerIds ?? rig.expressionIds;
    const layers = rig.expressionLayers?.[expression] ?? {};
    const index = key => Math.max(0, layerIds.indexOf(layers[key] ?? expression));
    for (const [key, layer] of [['brows', rig.brow], ['cheeks', rig.cheek]]) {
      const density = layer.pixelScale;
      context.drawImage(images[key], index(key) * layer.width * density, 0, layer.width * density, layer.height * density, layer.x, layer.y, layer.width, layer.height);
    }
    const eyeState = Math.max(blink ? blinkFrame(phase) : 0, layers.eyeFrame ?? 0);
    if (images.eyes) {
      const eye = rig.eye;
      context.drawImage(images.eyes, eyeState * eye.width, index('eyes') * eye.height, eye.width, eye.height, eye.x, eye.y, eye.width, eye.height);
    } else if (eyeState === 3 && images.blink) {
      context.drawImage(images.blink, 0, 0, rig.width, rig.height);
    }
    const opening = clamp(mouthOpen);
    const round = roundness ?? (speaking && (phase >= 2.22 && phase < 2.51 || phase >= 4.16 && phase < 4.46) ? 1 : 0);
    let mouthState = opening < 0.06 ? 0 : opening < 0.28 ? 1 : opening < 0.66 ? 2 : 3;
    if (opening >= 0.16 && round > 0.5) mouthState = 4;
    if (speaking && opening < 0.06 && (phase >= 1.72 && phase < 1.8 || phase >= 2.83 && phase < 2.91)) mouthState = 5;
    const mouth = rig.mouth;
    const density = mouth.pixelScale;
    if (mouthState === 0 && !speaking) {
      context.drawImage(images.restMouths, index('restMouths') * mouth.width * density, 0, mouth.width * density, mouth.height * density, mouth.x, mouth.y, mouth.width, mouth.height);
    } else {
      context.drawImage(images.mouths, mouthState * mouth.width * density, 0, mouth.width * density, mouth.height * density, mouth.x, mouth.y, mouth.width, mouth.height);
    }
    if (expression === 'crying') {
      if (!speaking) {
        context.save();
        const sob = context.createLinearGradient(0, 154, 0, 175);
        sob.addColorStop(0, '#61272d'); sob.addColorStop(1, '#a7494e');
        context.fillStyle = sob; context.strokeStyle = '#884b40'; context.lineWidth = 0.9;
        context.beginPath(); context.moveTo(108, 167);
        context.bezierCurveTo(107, 155, 115, 152, 121, 157);
        context.bezierCurveTo(126, 160, 131, 160, 137, 157);
        context.bezierCurveTo(144, 152, 150, 157, 148, 168);
        context.bezierCurveTo(137, 175, 120, 175, 108, 167);
        context.closePath(); context.fill(); context.stroke(); context.clip();
        context.fillStyle = '#ed958d'; context.beginPath(); context.ellipse(128, 174, 16, 7, 0, 0, tau); context.fill();
        context.strokeStyle = '#fff0d9'; context.lineWidth = 2.5;
        context.beginPath(); context.moveTo(116, 156); context.quadraticCurveTo(128, 166, 142, 156); context.stroke();
        context.restore();
      }
      drawExpressionAccent(context, expression, { time: motion ? time : 0 });
    }
  }
  context.restore();
  if (jaw) drawJawOutline(context, jaw);
  context.restore();
  if (facial && expression !== 'crying') drawExpressionAccent(context, expression);
  context.restore();
}

// Wardrobe layers share the original facial rig and angled expression atlases.
export function drawWardrobePortrait(context, images, rig, outfit, options = {}) {
  const { view = 'front', expression = 'neutral', x = 0, y = 0, size = rig.width } = options;
  const cell = outfit?.upperBody.cellSize;
  const crop = outfit?.upperBody.rects[outfit.upperBody.views.indexOf(view)];
  if (view === 'front') {
    const destination = outfit ? [crop.x, crop.y, crop.width, crop.height].map(value => value * rig.width / cell) : undefined;
    if (destination) { destination[1] -= 6; destination[3] += 6; }
    drawPersonalIP(context, outfit ? { ...images, body: images.outfit } : images, rig,
      { ...options, ...(outfit ? { cleanJaw: true, bodySource: [crop.x, crop.y, crop.width, crop.height],
        bodyDestination: destination } : {}) });
    return;
  }
  const atlas = rig.angledExpressions[view];
  const index = Math.max(0, rig.expressionIds.indexOf(expression));
  const jaw = rig.wardrobeJaws?.[view]?.[index];
  context.save(); context.translate(x, y); context.scale(size / rig.width, size / rig.height);
  if (outfit) {
    const column = outfit.upperBody.views.indexOf(view);
    const [dx, dy, dw, dh] = [crop.x, crop.y, crop.width, crop.height].map(value => value * rig.width / cell);
    // Keep the neck underneath the antialiased jaw, with the lower frame fixed.
    context.drawImage(images.outfit, column * cell + crop.x, crop.y, crop.width, crop.height,
      dx, dy - 6, dw, dh + 6);
    context.save();
    context.beginPath(); context.moveTo(0, 0); context.lineTo(256, 0); context.lineTo(256, 164);
    if (view === 'left45') {
      context.lineTo(171, 164);
      context.bezierCurveTo(158, 179, 136, 185, jaw ? jaw[0] : 111, jaw ? jaw[1] : 184.2);
      if (jaw) jawCurve(context, jaw);
      else context.bezierCurveTo(105, 185.8, 85, 178.5, 67, 164);
    } else {
      if (jaw) {
        context.lineTo(jaw[0], jaw[1]); jawCurve(context, jaw);
        context.bezierCurveTo(132, 177, 115, 171, 103, 163.5);
      } else {
        context.lineTo(193, 164); context.bezierCurveTo(184, 174.5, 166, 181.7, 156, 183.2);
        context.bezierCurveTo(143, 183.5, 118, 174.5, 103, 163.5);
      }
      context.lineTo(107, 171); context.bezierCurveTo(108, 180, 102, 181, 99, 173);
      context.lineTo(93, 164);
    }
    context.lineTo(0, 164); context.closePath(); context.clip();
  }
  context.drawImage(images[view], index % atlas.columns * atlas.cellSize,
    Math.floor(index / atlas.columns) * atlas.cellSize, atlas.cellSize, atlas.cellSize, 0, 0, rig.width, rig.height);
  if (outfit) context.restore();
  if (outfit && jaw) drawJawOutline(context, jaw);
  if (expression !== 'crying') drawExpressionAccent(context, expression);
  context.restore();
}
