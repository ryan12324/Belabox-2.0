/**
 * OutputManager – manages multiple output destinations for simulcast streaming.
 *
 * Each scene has an `outputs[]` array. Each output has:
 *   { id, name, enabled, protocol, url, key, videoBitrate, audioBitrate, resolution }
 *
 * `resolution` may be null (use scene default), or a string like '1080x1920'
 * for vertical TikTok/Reels output. The server builds separate FFmpeg encode
 * chains per enabled destination using the `split` filter.
 */

'use strict';

/** Platform presets for common streaming services */
const PLATFORM_PRESETS = {
  twitch: {
    name: 'Twitch',
    protocol: 'rtmp',
    url: 'rtmp://live.twitch.tv/app',
    key: '',
    videoBitrate: 6000,
    audioBitrate: 160,
    resolution: null,
    hint: 'Max 6,000 kbps. Get your stream key at twitch.tv/dashboard/settings',
  },
  youtube: {
    name: 'YouTube',
    protocol: 'rtmp',
    url: 'rtmp://a.rtmp.youtube.com/live2',
    key: '',
    videoBitrate: 4500,
    audioBitrate: 128,
    resolution: null,
    hint: 'Get your stream key at studio.youtube.com',
  },
  tiktok: {
    name: 'TikTok',
    protocol: 'rtmp',
    url: 'rtmp://push.tiktokcdn.com/live/',
    key: '',
    videoBitrate: 3000,
    audioBitrate: 128,
    resolution: '1080x1920',
    hint: 'Vertical (9:16). Get stream URL+key from TikTok LIVE Studio or Creator Studio',
  },
  facebook: {
    name: 'Facebook',
    protocol: 'rtmp',
    url: 'rtmps://live-api-s.facebook.com:443/rtmp/',
    key: '',
    videoBitrate: 4000,
    audioBitrate: 128,
    resolution: null,
    hint: 'Get your live key at facebook.com/live/producer',
  },
  custom: {
    name: 'Custom',
    protocol: 'rtmp',
    url: '',
    key: '',
    videoBitrate: 3000,
    audioBitrate: 128,
    resolution: null,
    hint: '',
  },
};

function generateOutputId() {
  return `out-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
}

class OutputManager {
  constructor() {
    /** @type {Array<{id,name,enabled,protocol,url,key,videoBitrate,audioBitrate,resolution}>} */
    this._outputs = [
      {
        id: generateOutputId(),
        name: 'Stream',
        enabled: true,
        protocol: 'rtmp',
        url: '',
        key: '',
        videoBitrate: 3000,
        audioBitrate: 128,
        resolution: null,
      },
    ];
  }

  // ── Public API ────────────────────────────────────────────────────────────

  get outputs() { return this._outputs; }

  /** Replace all outputs (e.g. when switching scenes) */
  loadOutputs(outputs) {
    if (!Array.isArray(outputs) || outputs.length === 0) return;
    this._outputs = outputs;
    this._renderList();
    this._syncPreviewSelect();
  }

  // ── Add from preset ───────────────────────────────────────────────────────

  addFromPreset(presetKey) {
    const preset = PLATFORM_PRESETS[presetKey] || PLATFORM_PRESETS.custom;
    document.getElementById('new-output-name').value = preset.name;
    document.getElementById('new-output-protocol').value = preset.protocol;
    document.getElementById('new-output-url').value = preset.url;
    document.getElementById('new-output-key').value = preset.key;
    document.getElementById('new-output-vbitrate').value = String(preset.videoBitrate);
    document.getElementById('new-output-abitrate').value = String(preset.audioBitrate);
    const resEl = document.getElementById('new-output-resolution');
    if (resEl) resEl.value = preset.resolution || '';

    const hintEl = document.getElementById('output-preset-hint');
    if (hintEl) {
      hintEl.textContent = preset.hint || '';
      hintEl.style.display = preset.hint ? '' : 'none';
    }
  }

  // ── Confirm add from modal ────────────────────────────────────────────────

  addFromModal() {
    const name = document.getElementById('new-output-name').value.trim() || 'Stream';
    const protocol = document.getElementById('new-output-protocol').value;
    const url = document.getElementById('new-output-url').value.trim();
    const key = document.getElementById('new-output-key').value.trim();
    const vbitrate = parseInt(document.getElementById('new-output-vbitrate').value, 10) || 3000;
    const abitrate = parseInt(document.getElementById('new-output-abitrate').value, 10) || 128;
    const resEl = document.getElementById('new-output-resolution');
    const resolution = (resEl && resEl.value) ? resEl.value : null;

    if (!url) throw new Error('Stream URL is required');

    const output = {
      id: generateOutputId(),
      name,
      enabled: true,
      protocol,
      url,
      key,
      videoBitrate: vbitrate,
      audioBitrate: abitrate,
      resolution,
    };

    this._outputs.push(output);
    this._renderList();
    return output;
  }

  // ── Remove ────────────────────────────────────────────────────────────────

  remove(id) {
    this._outputs = this._outputs.filter(o => o.id !== id);
    this._renderList();
  }

  // ── Toggle enabled ────────────────────────────────────────────────────────

  toggle(id) {
    const o = this._outputs.find(x => x.id === id);
    if (o) { o.enabled = !o.enabled; this._renderList(); }
  }

  // ── Render destination list ───────────────────────────────────────────────

  _renderList() {
    const container = document.getElementById('output-destinations-list');
    if (!container) return;

    if (this._outputs.length === 0) {
      container.innerHTML = '<p class="prop-empty" style="padding:10px">No output destinations. Click ＋ to add one.</p>';
      this._syncPreviewSelect();
      return;
    }

    container.innerHTML = '';
    for (const output of this._outputs) {
      const div = document.createElement('div');
      div.className = `output-dest${output.enabled ? '' : ' disabled'}`;
      div.dataset.id = output.id;

      const resLabel = output.resolution ? ` · ${output.resolution.replace('x', '×')}` : '';
      const protocolBadge = output.protocol.toUpperCase();
      const urlDisplay = output.url
        ? (output.url.length > 32 ? output.url.slice(0, 30) + '…' : output.url)
        : '(no URL)';

      div.innerHTML = `
        <div class="dest-header">
          <label class="dest-toggle" title="${output.enabled ? 'Disable' : 'Enable'}">
            <input type="checkbox" class="dest-enable-cb" data-id="${output.id}"
              ${output.enabled ? 'checked' : ''}>
            <span class="dest-name">${esc(output.name)}</span>
          </label>
          <span class="dest-badge">${protocolBadge}${resLabel}</span>
          <button class="btn-icon dest-del" data-id="${output.id}" title="Remove">✕</button>
        </div>
        <div class="dest-meta">${esc(urlDisplay)}${output.key ? ' · ****' : ''} · ${output.videoBitrate}k</div>
        <div class="dest-fields" style="display:none">
          <label class="prop-label">Protocol</label>
          <select class="prop-input dest-proto" data-id="${output.id}">
            <option value="rtmp"${output.protocol === 'rtmp' ? ' selected' : ''}>RTMP</option>
            <option value="srt"${output.protocol === 'srt' ? ' selected' : ''}>SRT</option>
          </select>
          <label class="prop-label">URL</label>
          <input class="prop-input dest-url" type="text" data-id="${output.id}" value="${esc(output.url)}" />
          <label class="prop-label">Stream Key</label>
          <input class="prop-input dest-key" type="password" data-id="${output.id}" value="${esc(output.key)}" />
          <div class="prop-row">
            <div>
              <label class="prop-label">Video (kbps)</label>
              <input class="prop-input dest-vbr" type="number" data-id="${output.id}" value="${output.videoBitrate}" min="500" max="50000" step="500" />
            </div>
            <div>
              <label class="prop-label">Audio (kbps)</label>
              <select class="prop-input dest-abr" data-id="${output.id}">
                ${[128, 192, 256, 320].map(v => `<option${output.audioBitrate === v ? ' selected' : ''}>${v}</option>`).join('')}
              </select>
            </div>
          </div>
          <label class="prop-label">Resolution Override</label>
          <select class="prop-input dest-res" data-id="${output.id}">
            <option value=""${!output.resolution ? ' selected' : ''}>— Use scene resolution —</option>
            <option value="1920x1080"${output.resolution === '1920x1080' ? ' selected' : ''}>1920×1080 (1080p)</option>
            <option value="1280x720"${output.resolution === '1280x720' ? ' selected' : ''}>1280×720 (720p)</option>
            <option value="854x480"${output.resolution === '854x480' ? ' selected' : ''}>854×480 (480p)</option>
            <option value="1080x1920"${output.resolution === '1080x1920' ? ' selected' : ''}>1080×1920 (vertical – TikTok)</option>
            <option value="720x1280"${output.resolution === '720x1280' ? ' selected' : ''}>720×1280 (vertical HD)</option>
          </select>
        </div>
      `;

      // Wire expand/collapse on name click
      const header = div.querySelector('.dest-header');
      const fields = div.querySelector('.dest-fields');
      header.addEventListener('click', (e) => {
        if (e.target.closest('.dest-enable-cb') || e.target.closest('.dest-del')) return;
        const open = fields.style.display !== 'none';
        fields.style.display = open ? 'none' : '';
      });

      // Enable toggle
      div.querySelector('.dest-enable-cb').addEventListener('change', () => this.toggle(output.id));

      // Delete
      div.querySelector('.dest-del').addEventListener('click', (e) => {
        e.stopPropagation();
        this.remove(output.id);
      });

      // Inline edit fields
      const sync = () => {
        const o = this._outputs.find(x => x.id === output.id);
        if (!o) return;
        const urlEl = div.querySelector('.dest-url');
        const keyEl = div.querySelector('.dest-key');
        const vbrEl = div.querySelector('.dest-vbr');
        const abrEl = div.querySelector('.dest-abr');
        const resEl = div.querySelector('.dest-res');
        const protoEl = div.querySelector('.dest-proto');
        if (urlEl) o.url = urlEl.value.trim();
        if (keyEl) o.key = keyEl.value.trim();
        if (vbrEl) o.videoBitrate = parseInt(vbrEl.value, 10) || 3000;
        if (abrEl) o.audioBitrate = parseInt(abrEl.value, 10) || 128;
        if (resEl) o.resolution = resEl.value || null;
        if (protoEl) o.protocol = protoEl.value;
        // Update meta line without full re-render
        const meta = div.querySelector('.dest-meta');
        if (meta) {
          const disp = o.url ? (o.url.length > 32 ? o.url.slice(0, 30) + '…' : o.url) : '(no URL)';
          meta.textContent = `${disp}${o.key ? ' · ****' : ''} · ${o.videoBitrate}k`;
        }
        const badge = div.querySelector('.dest-badge');
        if (badge) {
          const rl = o.resolution ? ` · ${o.resolution.replace('x', '×')}` : '';
          badge.textContent = `${o.protocol.toUpperCase()}${rl}`;
        }
      };

      div.querySelectorAll('.dest-url, .dest-key').forEach(el => el.addEventListener('input', sync));
      div.querySelectorAll('.dest-vbr, .dest-abr, .dest-res, .dest-proto').forEach(el => el.addEventListener('change', () => {
        sync();
        this._syncPreviewSelect();
      }));

      container.appendChild(div);
    }
    this._syncPreviewSelect();
  }

  // ── Sync preview dropdown ─────────────────────────────────────────────────

  _syncPreviewSelect() {
    const sel = document.getElementById('preview-output-select');
    if (!sel) return;

    const currentVal = sel.value;
    sel.innerHTML = '';

    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Scene (current resolution)';
    sel.appendChild(defaultOpt);

    const verticalOutputs = this._outputs.filter(o => o.resolution);
    for (const o of verticalOutputs) {
      const opt = document.createElement('option');
      opt.value = o.resolution;
      opt.textContent = `${o.name} (${o.resolution.replace('x', '×')})`;
      sel.appendChild(opt);
    }

    // Restore previous selection if still available, else fall back to default
    const stillAvailable = Array.from(sel.options).some(opt => opt.value === currentVal);
    sel.value = stillAvailable ? currentVal : '';
    if (!stillAvailable && currentVal !== '') {
      // Previously-selected output was removed — reset canvas to scene resolution
      sel.dispatchEvent(new Event('change'));
    }

    // Show/hide the preview controls depending on whether there are vertical outputs
    const hidden = verticalOutputs.length === 0;
    const displayValues = { 'preview-output-sep': 'inline', 'preview-output-label': 'inline', 'preview-output-select': 'inline-block' };
    Object.entries(displayValues).forEach(([id, displayVal]) => {
      const el = document.getElementById(id);
      if (el) el.style.display = hidden ? 'none' : displayVal;
    });
  }
}

/** HTML-escape helper */
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
