(function () {
  const palette = Object.freeze({ background: '#F7F5EF', ink: '#24231F', muted: '#737168', accent: '#FFC712' });
  const formats = Object.freeze({
    portrait: { width: 1080, height: 1440, ratio: '3:4', margin: 96, fontSize: 160, titleWidth: 888, hero: [96, 0, 640], avatar: [780, 1140, 204] },
    landscape: { width: 1440, height: 1080, ratio: '4:3', margin: 96, fontSize: 164, titleWidth: 756, hero: [884, 256, 460], avatar: [1140, 780, 204] },
  });
  const defaults = Object.freeze({ kicker: 'AI 创作', lines: ['用 AI', '做封面'], avatarScale: 1 });
  const font = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

  function contain(context, image, x, y, size) {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const scale = Math.min(size / width, size / height);
    context.drawImage(image, x + (size - width * scale) / 2, y + (size - height * scale) / 2, width * scale, height * scale);
  }

  function draw(canvas, { format = 'portrait', kicker = defaults.kicker, lines = defaults.lines, hero, avatar, avatarScale = defaults.avatarScale }) {
    const layout = formats[format];
    if (!layout) throw new Error('请选择 3:4 或 4:3 画幅。');
    const title = lines.map(line => line.trim()).filter(Boolean);
    if (title.length < 1 || title.length > 2) throw new Error('请填写一到两行标题。');
    canvas.width = layout.width;
    canvas.height = layout.height;
    const context = canvas.getContext('2d');
    context.fillStyle = palette.background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';

    if (kicker.trim()) {
      context.font = '600 30px ' + font;
      const labelWidth = context.measureText(kicker.trim()).width + 40;
      context.fillStyle = palette.accent;
      context.beginPath();
      context.roundRect(layout.margin, 96, labelWidth, 56, 16);
      context.fill();
      context.fillStyle = palette.ink;
      const labelMetrics = context.measureText(kicker.trim());
      const labelY = 124 + (labelMetrics.actualBoundingBoxAscent - labelMetrics.actualBoundingBoxDescent) / 2;
      context.fillText(kicker.trim(), layout.margin + 20, labelY);
    }

    let size = hero ? layout.fontSize : 176;
    context.font = '700 ' + size + 'px ' + font;
    const widest = Math.max(...title.map(line => {
      const metric = context.measureText(line);
      return metric.actualBoundingBoxLeft + metric.actualBoundingBoxRight;
    }));
    const titleWidth = hero ? layout.titleWidth : layout.width - layout.margin * 2;
    size = Math.floor(size * Math.min(1, titleWidth / widest));
    context.font = '700 ' + size + 'px ' + font;
    context.textAlign = 'left';
    const leading = size * 1.2;
    const metrics = title.map(line => context.measureText(line));
    const ascent = metrics[0].actualBoundingBoxAscent;
    const descent = metrics[metrics.length - 1].actualBoundingBoxDescent;
    const blockWidth = Math.max(...metrics.map(metric => metric.actualBoundingBoxLeft + metric.actualBoundingBoxRight));
    const blockHeight = ascent + descent + (title.length - 1) * leading;
    const titleX = hero ? layout.margin : (layout.width - blockWidth) / 2;
    const centerY = hero ? layout.hero[1] + layout.hero[2] / 2 : layout.height / 2;
    const titleY = hero && format === 'portrait' ? 224 + ascent : centerY - blockHeight / 2 + ascent;
    context.fillStyle = palette.ink;
    title.forEach((line, index) => context.fillText(line, titleX + metrics[index].actualBoundingBoxLeft, titleY + index * leading));

    if (hero) {
      const [x, y, width] = layout.hero;
      const heroY = format === 'portrait' ? titleY + (title.length - 1) * leading + descent + 80 : y;
      context.save();
      context.beginPath();
      context.roundRect(x, heroY, width, width, 28);
      context.clip();
      contain(context, hero, x, heroY, width);
      context.restore();
    }
    const avatarSize = layout.avatar[2] * avatarScale;
    const avatarBounds = [canvas.width - layout.margin - avatarSize, canvas.height - layout.margin - avatarSize, avatarSize];
    contain(context, avatar, ...avatarBounds);
    return { width: canvas.width, height: canvas.height, ratio: layout.ratio, titleSize: size, avatarSize, avatarBounds };
  }

  globalThis.DouyinCover = Object.freeze({ palette, formats, defaults, draw });
})();
