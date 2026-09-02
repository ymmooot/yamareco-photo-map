/*
 * ヤマレコ 写真位置マップ
 *
 * 山行記録ページの写真一覧にある撮影時刻と、記録の GPX 軌跡(各点に UTC 時刻あり)を
 * 突き合わせ、各写真が撮影されたルート上の位置を Leaflet 地図にマーカー表示する。
 *
 * このスクリプトは manifest の world: "MAIN" によりページ本体と同じ JS 世界で動くため、
 * ページが持つ Leaflet の `L` と地図インスタンス `map` に直接アクセスできる。
 */
(() => {
  'use strict';

  const TAG = '[yamareco-photo-map]';
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  // 前後の軌跡点の間隔がこれ以下なら線形補間で位置を求める
  const INTERPOLATE_MAX_MS = 10 * 60 * 1000;
  // それ以上離れている場合、最寄りの軌跡点までがこの範囲内なら「推定」として採用
  const NEAREST_MAX_MS = 60 * 60 * 1000;

  if (window.__yrpmLoaded) return;
  window.__yrpmLoaded = true;

  const log = (...args) => console.log(TAG, ...args);

  // 現在開いているポップアップの前後の写真(左右キー操作用)
  let currentPopupNav = null;

  // ---------------------------------------------------------------------------
  // ユーティリティ
  // ---------------------------------------------------------------------------

  function waitFor(cond, { interval = 250, timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      (function tick() {
        let value = null;
        try {
          value = cond();
        } catch (_) {
          /* まだ初期化されていないだけなので無視 */
        }
        if (value) return resolve(value);
        if (Date.now() - started > timeout) return reject(new Error('timeout'));
        setTimeout(tick, interval);
      })();
    });
  }

  function getDid() {
    const m = location.pathname.match(/detail-(\d+)\.html/);
    if (m) return m[1];
    if (window.did) return String(window.did);
    return null;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatJst(ms) {
    const d = new Date(ms + JST_OFFSET_MS);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }

  // ---------------------------------------------------------------------------
  // 写真一覧の読み取り
  // ---------------------------------------------------------------------------

  // "2026年08月13日 07:23撮影" のような文字列を UTC ミリ秒に変換する。
  // ヤマレコの表示は日本時間とみなす。
  function parsePhotoTime(text) {
    const m = text && text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    return Date.UTC(y, mo - 1, d, h, mi) - JST_OFFSET_MS;
  }

  function collectPhotos() {
    const items = document.querySelectorAll('.photo-list .photo-list-wrap-item');
    const photos = [];
    items.forEach((item, idx) => {
      const link = item.querySelector('a.photo-list-wrap-item-wrap');
      const pid = (link && (link.dataset.id || (link.id || '').replace(/^plist-/, ''))) || null;
      const img = item.querySelector('img.photo-list-wrap-item-img');
      const info = item.querySelector('.highslide-caption-info');
      const captionEl = item.querySelector('.photo-list-wrap-item-caption');
      photos.push({
        index: idx + 1,
        pid,
        el: item,
        anchor: item.querySelector('div[style*="position"]') || item,
        thumb: img ? img.currentSrc || img.src : null,
        caption: captionEl ? captionEl.textContent.trim() : '',
        time: info ? parsePhotoTime(info.textContent) : null,
      });
    });
    return photos;
  }

  // ---------------------------------------------------------------------------
  // GPX の取得と時刻による位置推定
  // ---------------------------------------------------------------------------

  async function fetchTrackPoints(did) {
    const candidates = [];
    if (typeof window.url === 'string' && /\.gpx/.test(window.url)) candidates.push(window.url);
    candidates.push(`track-${did}.gpx`);

    for (const rel of candidates) {
      const abs = new URL(rel, location.href).toString();
      try {
        const res = await fetch(abs, { credentials: 'same-origin' });
        if (!res.ok) continue;
        const text = await res.text();
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        const pts = [];
        doc.querySelectorAll('trkpt').forEach((pt) => {
          const timeEl = pt.querySelector('time');
          if (!timeEl) return;
          const t = Date.parse(timeEl.textContent.trim());
          const lat = parseFloat(pt.getAttribute('lat'));
          const lon = parseFloat(pt.getAttribute('lon'));
          if (Number.isNaN(t) || Number.isNaN(lat) || Number.isNaN(lon)) return;
          pts.push({ t, lat, lon });
        });
        if (pts.length) {
          pts.sort((a, b) => a.t - b.t);
          return pts;
        }
      } catch (e) {
        log('GPX の取得に失敗', abs, e);
      }
    }
    return [];
  }

  // 時刻 t に対応する軌跡上の位置を返す。
  // 戻り値: { lat, lon, source: 'track' | 'approx' } または null
  function locateByTime(pts, t) {
    if (!pts.length) return null;

    // 二分探索: pts[i].t <= t < pts[i+1].t となる i を求める
    let lo = 0;
    let hi = pts.length - 1;
    if (t <= pts[0].t) {
      return pts[0].t - t <= NEAREST_MAX_MS ? { ...pts[0], source: 'approx' } : null;
    }
    if (t >= pts[hi].t) {
      return t - pts[hi].t <= NEAREST_MAX_MS ? { ...pts[hi], source: 'approx' } : null;
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = pts[lo];
    const b = pts[hi];
    const span = b.t - a.t;
    if (span <= INTERPOLATE_MAX_MS) {
      const r = span === 0 ? 0 : (t - a.t) / span;
      return {
        lat: a.lat + (b.lat - a.lat) * r,
        lon: a.lon + (b.lon - a.lon) * r,
        source: 'track',
      };
    }
    const nearest = t - a.t <= b.t - t ? a : b;
    const gap = Math.abs(nearest.t - t);
    return gap <= NEAREST_MAX_MS ? { lat: nearest.lat, lon: nearest.lon, source: 'approx' } : null;
  }

  // 写真自体に GPS 位置が付いているもの(ヤマレコ側が既にマーカー表示しているもの)を取得
  async function fetchGpsPhotos(did) {
    const result = new Map();
    try {
      const abs = new URL(`include/aj_getphotolist.php?did=${encodeURIComponent(did)}`, location.href);
      const res = await fetch(abs.toString(), { credentials: 'same-origin' });
      if (!res.ok) return result;
      const data = await res.json();
      if (Array.isArray(data)) {
        data.forEach((p) => {
          const lat = parseFloat(p.lat);
          const lon = parseFloat(p.lon);
          if (p.pid && !Number.isNaN(lat) && !Number.isNaN(lon)) result.set(p.pid, { lat, lon });
        });
      }
    } catch (e) {
      log('GPS 付き写真リストの取得に失敗(無視して続行)', e);
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // 地図への描画
  // ---------------------------------------------------------------------------

  function buildPopupHtml(photo, did, nav) {
    const detailUrl = `photodetail.php?did=${encodeURIComponent(did)}&pid=${encodeURIComponent(photo.pid || '')}`;
    const sourceLabel = { track: '軌跡の時刻から推定', gps: '写真の GPS 情報', approx: '軌跡から離れた時刻(概略)' }[photo.source];
    const thumb = photo.thumb
      ? `<a href="${escapeHtml(detailUrl)}" target="_blank" rel="nofollow noopener"><img src="${escapeHtml(photo.thumb)}" alt=""></a>`
      : '';
    const body =
      '<div class="yrpm-popup-body">' +
      `<button type="button" class="yrpm-nav yrpm-nav-prev" title="前の写真"${nav.prev ? '' : ' disabled'}>&#9664;</button>` +
      `<div class="yrpm-popup-thumb">${thumb}</div>` +
      `<button type="button" class="yrpm-nav yrpm-nav-next" title="次の写真"${nav.next ? '' : ' disabled'}>&#9654;</button>` +
      '</div>';
    const caption = photo.caption ? `<div class="yrpm-popup-caption">${escapeHtml(photo.caption)}</div>` : '';
    const time = photo.time != null ? formatJst(photo.time) : '時刻不明';
    return (
      `<div class="yrpm-popup">${body}${caption}` +
      `<div class="yrpm-popup-meta">[${photo.index}] ${escapeHtml(time)} / ${escapeHtml(sourceLabel)}` +
      `<a href="#" class="yrpm-goto-list" data-index="${photo.index}">一覧へ</a></div></div>`
    );
  }

  function addMarkers(L, map, photos, did) {
    const layer = L.layerGroup();
    const markers = new Map();
    const placed = photos.filter((p) => p.lat != null);

    // 指定した写真のマーカーへ移動してポップアップを開く
    function showPhoto(photo) {
      const marker = markers.get(photo.index);
      if (!marker) return;
      const latlng = marker.getLatLng();
      // マーカーが画面内にあれば地図は動かさず、ポップアップの autoPan に任せる
      // (中央へ寄せてから autoPan が走ると地図が上下に揺れて見えるため)。
      // 画面外のときだけ即時に移動してから開く。
      if (!map.getBounds().pad(-0.15).contains(latlng)) {
        map.panTo(latlng, { animate: false });
      }
      marker.openPopup();
    }

    placed.forEach((photo, i) => {
      const nav = { prev: placed[i - 1] || null, next: placed[i + 1] || null };
      const icon = L.divIcon({
        className: `yrpm-marker yrpm-src-${photo.source}`,
        html: `<div class="yrpm-pin">${photo.index}</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        popupAnchor: [0, -12],
      });
      const marker = L.marker([photo.lat, photo.lon], {
        icon,
        title: `写真 ${photo.index}`,
        zIndexOffset: 500,
      });
      marker.bindPopup(buildPopupHtml(photo, did, nav), { minWidth: 240, maxWidth: 300 });
      marker.on('popupopen', (ev) => {
        const root = ev.popup.getElement();
        const link = root.querySelector('.yrpm-goto-list');
        if (link) {
          link.addEventListener('click', (e) => {
            e.preventDefault();
            flashListItem(photo);
          });
        }
        const prevBtn = root.querySelector('.yrpm-nav-prev');
        const nextBtn = root.querySelector('.yrpm-nav-next');
        if (prevBtn && nav.prev) prevBtn.addEventListener('click', () => showPhoto(nav.prev));
        if (nextBtn && nav.next) nextBtn.addEventListener('click', () => showPhoto(nav.next));
        currentPopupNav = nav;
      });
      marker.on('popupclose', () => {
        if (currentPopupNav === nav) currentPopupNav = null;
      });
      marker.addTo(layer);
      markers.set(photo.index, marker);
    });

    layer.addTo(map);

    // ポップアップ表示中は左右キーでも写真を送れるようにする
    document.addEventListener('keydown', (e) => {
      if (!currentPopupNav) return;
      const tag = (e.target && e.target.tagName) || '';
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || e.target.isContentEditable) return;
      if (e.key === 'ArrowLeft' && currentPopupNav.prev) {
        e.preventDefault();
        showPhoto(currentPopupNav.prev);
      } else if (e.key === 'ArrowRight' && currentPopupNav.next) {
        e.preventDefault();
        showPhoto(currentPopupNav.next);
      }
    });

    return { layer, markers, showPhoto };
  }

  function setMarkerActive(markers, index, active) {
    const marker = markers.get(index);
    const el = marker && marker.getElement();
    if (el) el.classList.toggle('yrpm-active', active);
  }

  function flashListItem(photo) {
    photo.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    photo.el.classList.add('yrpm-flash');
    setTimeout(() => photo.el.classList.remove('yrpm-flash'), 2000);
  }

  function addControl(L, map, layer, stats) {
    const Control = L.Control.extend({
      options: { position: 'topright' },
      onAdd() {
        const div = L.DomUtil.create('div', 'yrpm-control leaflet-bar');
        div.innerHTML =
          `<label><input type="checkbox" checked> 写真の位置 (${stats.placed}/${stats.total})</label>` +
          '<div class="yrpm-legend"><span class="yrpm-lg-track">軌跡から推定</span>' +
          '<span class="yrpm-lg-gps">GPS</span><span class="yrpm-lg-approx">概略</span></div>';
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);
        div.querySelector('input').addEventListener('change', (e) => {
          if (e.target.checked) layer.addTo(map);
          else map.removeLayer(layer);
        });
        return div;
      },
    });
    new Control().addTo(map);
  }

  // ---------------------------------------------------------------------------
  // 写真一覧側のバッジ
  // ---------------------------------------------------------------------------

  function addListBadges(photos, markers, showPhoto) {
    photos.forEach((photo) => {
      const badge = document.createElement('a');
      badge.className = 'yrpm-badge';
      if (photo.lat == null) {
        badge.classList.add('yrpm-none');
        badge.textContent = `${photo.index}`;
        badge.title = photo.time == null ? '撮影時刻が不明なため位置を推定できません' : '軌跡の記録時間から離れているため位置を推定できません';
      } else {
        badge.classList.add(`yrpm-src-${photo.source}`);
        badge.href = '#map';
        badge.textContent = `${photo.index} ▲`;
        badge.title = '地図上の撮影位置を表示';
        badge.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const mapEl = document.getElementById('map');
          if (mapEl) mapEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          showPhoto(photo);
        });
        photo.el.addEventListener('mouseenter', () => setMarkerActive(markers, photo.index, true));
        photo.el.addEventListener('mouseleave', () => setMarkerActive(markers, photo.index, false));
      }
      photo.anchor.appendChild(badge);
    });
  }

  // ---------------------------------------------------------------------------
  // メイン
  // ---------------------------------------------------------------------------

  async function main() {
    const did = getDid();
    if (!did) return;

    const photos = collectPhotos();
    if (!photos.length) {
      log('写真一覧が見つかりません');
      return;
    }

    let L;
    let map;
    try {
      ({ L, map } = await waitFor(() => {
        const l = window.L;
        const m = window.map;
        return l && m && typeof m.addLayer === 'function' ? { L: l, map: m } : null;
      }));
    } catch (_) {
      log('地図が初期化されませんでした');
      return;
    }

    const [pts, gpsPhotos] = await Promise.all([fetchTrackPoints(did), fetchGpsPhotos(did)]);
    if (!pts.length && !gpsPhotos.size) {
      log('時刻付きの GPX 軌跡が取得できませんでした');
      return;
    }

    let placed = 0;
    photos.forEach((photo) => {
      const gps = photo.pid && gpsPhotos.get(photo.pid);
      let pos = null;
      if (gps) pos = { ...gps, source: 'gps' };
      else if (photo.time != null) pos = locateByTime(pts, photo.time);
      if (pos) {
        photo.lat = pos.lat;
        photo.lon = pos.lon;
        photo.source = pos.source;
        placed++;
      }
    });

    const { layer, markers, showPhoto } = addMarkers(L, map, photos, did);
    addControl(L, map, layer, { placed, total: photos.length });
    addListBadges(photos, markers, showPhoto);
    log(`写真 ${photos.length} 枚のうち ${placed} 枚を地図に配置しました`);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main, { once: true });
  } else {
    main();
  }
})();
