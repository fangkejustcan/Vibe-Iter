// Shared island positions keep the painting, hit targets, docks and routes aligned.
const $ = (id) => document.getElementById(id);
const board = $('game-board');
const canvas = $('map');
const ctx = canvas.getContext('2d');
const boat = $('boat');
const modal = $('modal');
const mails = [...document.querySelectorAll('.mail')];
const islandButtons = [...document.querySelectorAll('.island')];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const letters = {
  light: {
    title: '一盏留给归人的灯', from: '小禾，离家后的第一个秋天', destination: 'lighthouse',
    text: '爸爸：\n你说只要那束光还亮着，我就找得到回家的路。今晚的船会晚一点，别再一个人坐在高塔的台阶上等。\n这次，换我给你带热汤。',
    reply: '守塔人把信读了两遍，把门口那张空椅子擦干净。\n「她小时候，总嫌这座塔太远。原来她一直记得回来的路。」',
    wrong: '这里没有那座高塔。信里提到的那束光，会从哪里照过来呢？',
  },
  song: {
    title: '风里的新歌', from: '阿远，写在返航的船上', destination: 'chime',
    text: '阿铃：\n你寄来的曲子，我终于会弹了。等海风穿过你屋檐下那些叮叮当当的小东西，就当是我在和你合奏。\n等我回来，我们再唱一遍。',
    reply: '阿铃没有说话，只把一串新风铃挂上屋檐。\n一阵风经过，三短一长。她笑了：「这次，他没有弹错。」',
    wrong: '这里很安静，听不见屋檐下叮叮当当的声音。再顺着海风找找吧。',
  },
  tide: {
    title: '今晚一起看潮汐', from: '一个终于不用赶船的人', destination: 'moon',
    text: '小满：\n还记得我们把愿望埋在弯弯的沙滩上吗？今晚退潮后，去那块像月牙的礁石旁等我。\n这回，我不赶最后一班船了。',
    reply: '小满把返程的船票折成一只小船，放在窗台上。\n「那今晚，我们可以一直坐到月亮升起来了。」',
    wrong: '这里没有信中那片弯弯的沙滩。月牙形的海湾，应该在另一座岛。',
  },
};
const islands = {
  lighthouse: { name: '灯塔岛', dock: [62, 50], visit: '灯还亮着，守塔人正望着远处。' },
  chime: { name: '风铃岛', dock: [-95, 18], visit: '屋檐下的风铃响了，阿铃在等一首新歌。' },
  moon: { name: '月湾岛', dock: [62, -48], visit: '月牙形沙滩露出了水面，小满正在看潮。' },
};
const state = { delivered: new Set(), selected: null, reading: null, selectionVersion: 0, boat: { x: 57, y: 48 }, trip: null, sound: false };
let width = 1, height = 1, scale = 1;
let audio;
function say(text) { $('brief').textContent = text; }
function setPosition(element, point) { element.style.left = `${point.x}%`; element.style.top = `${point.y}%`; }
function dockPoint(key) {
  const island = islands[key];
  return { x: island.x + island.dock[0] * scale / width * 100, y: island.y + island.dock[1] * scale / height * 100 };
}

function layoutWorld() {
  const mobile = matchMedia('(max-width: 700px)').matches;
  board.style.bottom = mobile ? `${document.querySelector('.game-shell').clientHeight - document.querySelector('.mailbag').offsetTop + 18}px` : '';
  const rect = board.getBoundingClientRect();
  width = rect.width; height = rect.height;
  scale = mobile ? Math.min(.66, width / 580, height / 440) : Math.max(.78, Math.min(1.15, width / 1100, height / 650));
  const positions = mobile ? [[23, 25], [78, 45], [46, 78]] : [[45, 24], [81, 44], [56, 76]];
  Object.values(islands).forEach((island, index) => { [island.x, island.y] = positions[index]; });
  islandButtons.forEach((button) => { setPosition(button, islands[button.dataset.key]); button.style.setProperty('--island-scale', scale); });
  const routes = $('routes');
  routes.setAttribute('viewBox', `0 0 ${width} ${height}`);
  routes.querySelectorAll('path').forEach((path, index) => {
    const a = dockPoint(path.dataset.from), b = dockPoint(path.dataset.to);
    const ax = a.x / 100 * width, ay = a.y / 100 * height, bx = b.x / 100 * width, by = b.y / 100 * height;
    path.setAttribute('d', `M ${ax} ${ay} Q ${(ax + bx) / 2 + [10, -20, -30][index] * scale} ${(ay + by) / 2 + 20 * scale} ${bx} ${by}`);
  });
  // Cap backing resolution while preserving CSS-pixel geometry on high-DPI screens.
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawMap();
  if (state.trip?.islandKey) {
    state.trip.from = { ...state.boat };
    state.trip.to = dockPoint(state.trip.islandKey);
    state.trip.started = performance.now();
    state.trip.duration = travelDuration(state.trip.to);
    setPosition($('waypoint'), state.trip.to);
  }
  setPosition(boat, state.boat);
}

// The map is original vector artwork; DOM controls retain readable island names.
function ellipse(x, y, rx, ry, fill, stroke) {
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, -.12, 0, Math.PI * 2);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}
function line(points, color, lineWidth = 1) {
  ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.strokeStyle = color; ctx.lineWidth = lineWidth; ctx.stroke();
}
function polygon(points, fill) {
  ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
}
function tree(x, y, size = 1) {
  ctx.fillStyle = '#647357'; ctx.fillRect(x - 2, y - 6, 4, 16);
  ellipse(x + 2, y - 15, 12 * size, 14 * size, '#315c4c');
  ellipse(x - 4, y - 19, 9 * size, 12 * size, '#547956');
  line([[x - 5, y - 20], [x - 2, y - 26]], '#96a57288');
}
function house(x, y, color, lit) {
  polygon([[x - 17, y - 2], [x + 11, y - 2], [x + 11, y + 22], [x - 17, y + 19]], '#d5c69d');
  polygon([[x + 11, y - 2], [x + 23, y - 10], [x + 23, y + 14], [x + 11, y + 22]], '#a8b08b');
  polygon([[x - 23, y - 2], [x - 3, y - 27], [x + 18, y - 2]], color);
  polygon([[x - 3, y - 27], [x + 10, y - 33], [x + 28, y - 10], [x + 18, y - 2]], '#ad705e');
  ctx.fillStyle = lit ? '#f4d98d' : '#45655a'; ctx.fillRect(x - 9, y + 4, 7, 9); ctx.fillRect(x + 14, y + 1, 5, 8);
  ctx.fillStyle = '#59715a'; ctx.fillRect(x + 3, y + 9, 6, 12);
}
function drawIsland(key, island) {
  ctx.save(); ctx.translate(width * island.x / 100, height * island.y / 100); ctx.scale(scale, scale);
  const lit = [...state.delivered].some((id) => letters[id].destination === key);
  [1.66, 1.38, 1.16].forEach((radius, i) => ellipse(0, 10, 82 * radius, 42 * radius, null, ['#8ab7a513', '#8ab7a526', '#a6ccac3b'][i]));
  ellipse(3, 17, 85, 43, '#082d3777');
  ellipse(0, 8, 83, 43, '#41817b');
  ellipse(-2, 2, 76, 39, '#b9c59a');
  ellipse(-4, -1, 69, 33, '#7d9a70');
  ellipse(-16, -2, 48, 23, '#8fa478');
  // Each pier points toward the shared water between the three islands.
  const [dx, dy] = island.dock;
  line([[dx * .59, dy * .59], [dx, dy]], '#6c8067', 16);
  line([[dx * .59, dy * .59 - 2], [dx, dy - 2]], '#c5b68b', 11);
  for (let t = .65; t < 1; t += .09) {
    const length = Math.hypot(dx, dy), nx = -dy / length * 6, ny = dx / length * 6;
    line([[dx * t - nx, dy * t - ny - 2], [dx * t + nx, dy * t + ny - 2]], '#7e8e7288');
  }
  if (key === 'lighthouse') {
    ctx.save();
    ctx.globalAlpha = lit ? .20 : .08;
    polygon([[0, -75], [155, -120], [165, -65]], '#f5e5ac'); ctx.restore();
    tree(-44, 1, .9); tree(39, -4, 1.1);
    polygon([[-18, 10], [18, 10], [11, -74], [-9, -74]], '#eee0b9');
    polygon([[5, 10], [18, 10], [11, -74], [4, -74]], '#bec7a5');
    polygon([[-14, -33], [14, -33], [13, -46], [-12, -46]], '#da8b70');
    ctx.fillStyle = '#516e5b'; ctx.fillRect(-8, -83, 20, 14);
    ctx.fillStyle = lit ? '#ffe7a4' : '#cbce93'; ctx.fillRect(-5, -81, 14, 10);
    polygon([[-16, -84], [2, -99], [19, -84]], '#df9276');
    ctx.fillStyle = '#49634e'; ctx.fillRect(-3, -4, 9, 17);
    line([[-18, -68], [18, -68]], '#64785b', 2);
    line([[-10, -68], [-10, -75]], '#64785b'); line([[13, -68], [13, -75]], '#64785b');
    ellipse(-31, 24, 6, 4, '#b8b690');
  } else if (key === 'chime') {
    tree(49, -8, 1.2); tree(-41, -3, .8);
    house(-15, -12, '#de997a', lit); house(29, 8, '#cead72', lit);
    line([[-48, -28], [0, -39], [45, -22]], '#cad7aa', 1.5);
    [-34, -19, -1, 17, 34].forEach((x, i) => {
      const y = -30 - Math.sin(i / 4 * Math.PI) * 7;
      line([[x, y], [x, y + 13]], '#d5d9ac');
      ellipse(x, y + 15, 3, 4, i % 2 ? '#e0a482' : '#d3dca4');
    });
    line([[-37, 18], [-15, 25], [9, 24]], '#c3bc9199', 3);
  } else {
    // A crescent of sand wraps a quiet inlet.
    ellipse(-20, 3, 49, 26, '#d8caa1');
    ellipse(-35, -5, 43, 23, '#41817b');
    ellipse(-41, -10, 38, 18, '#20545b');
    tree(27, -9, 1.05); house(35, 10, '#92a282', lit);
    ellipse(-16, 21, 7, 4, '#8c9c7f'); ellipse(-31, 18, 5, 3, '#9ba889');
    line([[-42, 6], [-23, 12], [-6, 9]], '#eee3b577');
  }
  [[-65, 18], [65, -11], [30, 34]].forEach(([x, y]) => { ellipse(x, y, 4, 2, '#a1b68b'); });
  if (lit) { ellipse(0, 48, 5, 2, '#e0dc9b'); }
  ctx.restore();
}
function drawMap() {
  ctx.clearRect(0, 0, width, height);
  // Deterministic wave marks and soundings stay still as the viewport changes.
  for (let i = 0; i < 150; i++) {
    const x = ((i * 137.508) % 997) / 997 * width, y = ((i * 89.13) % 991) / 991 * height;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + 6, y + 3, x + 13 + i % 10, y);
    ctx.strokeStyle = i % 5 === 0 ? '#c0d7b72b' : '#91bba117'; ctx.lineWidth = 1; ctx.stroke();
  }
  ctx.setLineDash([2, 12]);
  ellipse(width * .59, height * .5, width * .35, height * .46, null, '#9cc2a818');
  ctx.setLineDash([]);
  Object.entries(islands).forEach(([key, island]) => drawIsland(key, island));
  // A pair of distant gulls, never a required click target.
  const gullX = width * .64, gullY = height * .12;
  [[0, 0], [24, 14]].forEach(([x, y]) => line([[gullX + x - 6, gullY + y + 2], [gullX + x, gullY + y], [gullX + x + 6, gullY + y + 3]], '#b9d2bd88'));
}

function travelDuration(to) {
  if (reducedMotion.matches) return 80;
  const distance = Math.hypot((to.x - state.boat.x) * width / 100, (to.y - state.boat.y) * height / 100);
  return Math.max(450, Math.min(1800, distance / 400 * 1000));
}
function sail(to, onArrival, islandKey = null) {
  const target = { x: Math.max(4, Math.min(96, to.x)), y: Math.max(6, Math.min(94, to.y)) };
  state.trip = { from: { ...state.boat }, to: target, started: performance.now(), duration: travelDuration(target), onArrival, islandKey };
  setPosition($('waypoint'), target); $('waypoint').classList.remove('hidden');
  boat.dataset.sailing = 'true'; boat.setAttribute('aria-label', '邮船，航行中');
  islandButtons.forEach((button) => button.classList.toggle('visiting', button.dataset.key === islandKey));
}
function animate(now) {
  const trip = state.trip;
  if (trip) {
    const progress = Math.min(1, (now - trip.started) / trip.duration);
    const eased = progress * progress * (3 - 2 * progress);
    state.boat = { x: trip.from.x + (trip.to.x - trip.from.x) * eased, y: trip.from.y + (trip.to.y - trip.from.y) * eased };
    setPosition(boat, state.boat);
    if (progress === 1) {
      state.trip = null; boat.dataset.sailing = 'false'; boat.setAttribute('aria-label', '邮船，停泊中');
      $('waypoint').classList.add('hidden');
      trip.onArrival?.();
    }
  }
  requestAnimationFrame(animate);
}
function renderLetter() {
  const id = state.reading, letter = letters[id];
  const delivered = state.delivered.has(id);
  $('letter-sheet').classList.toggle('reply', delivered);
  if (letter) {
    $('letter-meta').textContent = delivered ? `${islands[letter.destination].name} · 已送达` : `寄信人：${letter.from}`;
    $('letter-title').textContent = delivered ? '信送到了，故事还在继续。' : letter.title;
    $('letter-copy').textContent = delivered ? letter.reply : letter.text;
    $('letter-action').textContent = delivered ? (state.delivered.size === 3 ? '三封信都有了回音。谢谢你，邮差。' : '还有人在等信。选下一封，继续航行 →') : '信应该送到哪里？悬停或探访小岛，找找线索。';
  } else {
    $('letter-meta').textContent = '地址被海水打湿了';
    $('letter-title').textContent = '有些地址，写在故事里。';
    $('letter-copy').textContent = '先选一封信。读一读留下的线索，猜猜是谁在等它，再驾驶邮船送过去。';
    $('letter-action').textContent = '↑ 选一封信，开始今天的航行';
  }
  mails.forEach((mail, index) => {
    mail.setAttribute('aria-pressed', String(mail.dataset.key === id));
    mail.classList.toggle('delivered', state.delivered.has(mail.dataset.key));
    mail.querySelector('i').textContent = state.delivered.has(mail.dataset.key) ? '✓' : `0${index + 1}`;
    mail.draggable = !state.delivered.has(mail.dataset.key);
  });
}
function selectLetter(id) {
  state.selectionVersion++;
  state.reading = id; state.selected = state.delivered.has(id) ? null : id;
  renderLetter();
  say(state.selected ? `读读《${letters[id].title}》，你觉得它该去哪里？` : '这是收件人留下的回音。你也可以继续在海上走走。');
}
function updateProgress() {
  const count = state.delivered.size;
  $('progress-text').textContent = `${count} / 3`;
  $('bag-count').textContent = count === 3 ? '今日的等待，都有了回音' : `还剩 ${3 - count} 封信，等你送达`;
  islandButtons.forEach((button) => button.classList.toggle('delivered', [...state.delivered].some((id) => letters[id].destination === button.dataset.key)));
  drawMap();
}
function visitIsland(key) {
  const island = islands[key], selected = state.selected, version = state.selectionVersion;
  say(`正驶向${island.name}……${selected ? '靠岸后尝试投递。' : '去看看那里有什么故事。'}`);
  closePopovers();
  sail(dockPoint(key), () => {
    if (!selected || state.selected !== selected || state.selectionVersion !== version) {
      say(`抵达${island.name}。${island.visit}${state.delivered.size < 3 ? ' 选好信后再点岛投递。' : ''}`);
      return;
    }
    const letter = letters[selected];
    if (letter.destination !== key) {
      say(`这封信还没找到收件人。${letter.wrong}`);
      return;
    }
    state.delivered.add(selected); state.selected = null;
    say(`送达成功 · ${island.name}。${state.delivered.size < 3 ? '收件人的回音，留在了你的邮包里。' : '今天的信，全都送到了。'}`);
    renderLetter(); updateProgress(); chime();
    if (state.delivered.size === 3) modal.showModal();
  }, key);
}
function chime() {
  if (!state.sound) return;
  try {
    audio ||= new AudioContext(); void audio.resume().catch(() => {});
    [523.25, 659.25, 783.99].forEach((frequency, index) => {
      const oscillator = audio.createOscillator(), gain = audio.createGain(), at = audio.currentTime + index * .12;
      oscillator.frequency.value = frequency; gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(.05, at + .02); gain.gain.exponentialRampToValueAtTime(.001, at + .4);
      oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(at); oscillator.stop(at + .41);
    });
  } catch { say('提示音暂不可用，航行和投递仍可继续。'); }
}
function closePopovers() {
  ['help', 'settings'].forEach((name) => { $(`${name}-panel`).classList.add('hidden'); $(`${name}-toggle`).setAttribute('aria-expanded', 'false'); });
}
function resetGame() {
  state.trip = null; state.delivered.clear(); state.selected = null; state.reading = null; state.selectionVersion++;
  state.boat = { x: 57, y: 48 }; setPosition(boat, state.boat); boat.dataset.sailing = 'false'; boat.setAttribute('aria-label', '邮船，停泊中');
  $('waypoint').classList.add('hidden'); islandButtons.forEach((button) => button.classList.remove('visiting'));
  modal.close(); closePopovers(); renderLetter(); updateProgress();
  say('邮包重新整理好了。选一封信，开始另一段归航。');
}

mails.forEach((mail) => {
  mail.addEventListener('click', () => selectLetter(mail.dataset.key));
  mail.addEventListener('dragstart', (event) => {
    if (state.delivered.has(mail.dataset.key)) { event.preventDefault(); return; }
    // Keep the source envelope still during native drag. Expanding a different
    // letter here would move the source under the pointer before drag setup ends.
    event.dataTransfer.setData('text/plain', mail.dataset.key); event.dataTransfer.effectAllowed = 'move';
    say(`把《${letters[mail.dataset.key].title}》拖到你选择的岛上。`);
  });
  mail.addEventListener('dragend', () => islandButtons.forEach((button) => button.classList.remove('drag-over')));
});
islandButtons.forEach((button) => {
  button.addEventListener('click', () => visitIsland(button.dataset.key));
  button.addEventListener('dragover', (event) => { event.preventDefault(); button.classList.add('drag-over'); });
  button.addEventListener('dragleave', (event) => { if (!button.contains(event.relatedTarget)) button.classList.remove('drag-over'); });
  button.addEventListener('drop', (event) => {
    event.preventDefault(); button.classList.remove('drag-over');
    const id = event.dataTransfer.getData('text/plain');
    if (!letters[id] || state.delivered.has(id)) return;
    selectLetter(id); visitIsland(button.dataset.key);
  });
});
canvas.addEventListener('click', (event) => {
  closePopovers(); canvas.focus({ preventScroll: true });
  const rect = canvas.getBoundingClientRect(), to = { x: (event.clientX - rect.left) / rect.width * 100, y: (event.clientY - rect.top) / rect.height * 100 };
  say('邮船出发了。跟着海风，自由航行。');
  sail(to, () => say(state.selected ? '已抵达这片海面。选一座岛，试着把信送过去。' : '已抵达这片海面。选一封信，或去岛上探访。'));
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { closePopovers(); return; }
  const directions = { ArrowLeft: [-4, 0], ArrowRight: [4, 0], ArrowUp: [0, -5], ArrowDown: [0, 5] };
  if (modal.open || !directions[event.key] || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  event.preventDefault();
  const [dx, dy] = directions[event.key];
  sail({ x: state.boat.x + dx, y: state.boat.y + dy }, () => say('邮船已移动。点击小岛可以靠岸。'));
  // Short keyboard steps remain responsive when a key is held down.
  state.trip.duration = reducedMotion.matches ? 40 : 110;
  say('正在驾驶邮船。点击小岛可以靠岸投递。');
});
['help', 'settings'].forEach((name) => {
  $(`${name}-toggle`).addEventListener('click', () => {
    const opening = $(`${name}-panel`).classList.contains('hidden'); closePopovers();
    if (opening) { $(`${name}-panel`).classList.remove('hidden'); $(`${name}-toggle`).setAttribute('aria-expanded', 'true'); }
  });
});
$('help-close').addEventListener('click', () => { closePopovers(); $('help-toggle').focus(); });
$('route-toggle').addEventListener('change', (event) => { $('routes').classList.toggle('hidden', !event.target.checked); });
$('sound-toggle').addEventListener('change', (event) => { state.sound = event.target.checked; say(state.sound ? '投递提示音已打开。' : '投递提示音已关闭。'); chime(); });
$('reset').addEventListener('click', () => { resetGame(); mails[0].focus(); });
$('play-again').addEventListener('click', () => { resetGame(); mails[0].focus(); });
$('modal-close').addEventListener('click', () => modal.close());
modal.addEventListener('close', () => canvas.focus({ preventScroll: true }));
new ResizeObserver(layoutWorld).observe(board);
new ResizeObserver(layoutWorld).observe(document.querySelector('.mailbag'));
window.addEventListener('resize', layoutWorld);
layoutWorld();
requestAnimationFrame(animate);
