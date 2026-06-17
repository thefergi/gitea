import type {FrontendRenderFunc} from '../plugin.ts';

// TIA Portal LAD renderer for Gitea.
// Detects a TIA block export (SW.Blocks.* XML), decodes each network's ladder
// topology (series/parallel from the FlgNet wire graph — same algorithm as
// TiaConnector's LadDecoder), and renders the ladder graphically. Returns false
// for non-TIA XML so Gitea falls back to its default code view.

function ln(el: Element | null): string {
  return el?.tagName?.replace(/^.*:/, '') ?? '';
}

function getAccessOperand(access: Element): string | null {
  let s = '';
  const comps = [...access.getElementsByTagName('*')].filter(e => ln(e) === 'Component' && e.parentNode && ln(e.parentNode) === 'Symbol');
  for (const c of comps) {
    const n = c.getAttribute('Name');
    if (n) { s += s ? '.' + n : n; }
  }
  if (s) return s;
  const cv = [...access.getElementsByTagName('*')].find(e => ln(e) === 'ConstantValue');
  return cv?.textContent?.trim() || null;
}

function buildRung(flg: Element): {coil: string, negatedCoil: boolean, tree: any} | null {
  const partsEl = [...flg.children].find(e => ln(e) === 'Parts');
  if (!partsEl) return null;

  // accesses: uid -> operand
  const access: Record<string, string> = {};
  for (const a of [...partsEl.children].filter(e => ln(e) === 'Access')) {
    const uid = a.getAttribute('UId');
    const op = getAccessOperand(a);
    if (uid && op) access[uid] = op;
  }

  // parts: uid -> {name, negated}
  const partName: Record<string, string> = {};
  const partNeg: Record<string, boolean> = {};
  for (const p of [...partsEl.children].filter(e => ln(e) === 'Part')) {
    const uid = p.getAttribute('UId');
    if (!uid) continue;
    partName[uid] = (p.getAttribute('Name') || '').trim();
    const neg = [...p.children].find(e => ln(e) === 'Negated');
    const nv = neg?.getAttribute('Name');
    partNeg[uid] = !!nv && nv !== 'false';
  }

  // wires -> nodes; part -> node ids; node -> access uids; powerrail nodes
  const partNodes: Record<string, Set<string>> = {};
  const nodeAccess: Record<string, string[]> = {};
  const powerrail = new Set<string>();
  let nodeGen = 0;
  const wiresEl = [...flg.children].find(e => ln(e) === 'Wires');
  if (!wiresEl) return null;

  for (const w of [...wiresEl.children].filter(e => ln(e) === 'Wire')) {
    const nid = w.getAttribute('UId') || ('N' + nodeGen++);
    if ([...w.children].some(e => ln(e) === 'Powerrail')) powerrail.add(nid);
    for (const nc of [...w.children].filter(e => ln(e) === 'NameCon')) {
      const pu = nc.getAttribute('UId');
      if (pu) { (partNodes[pu] ||= new Set()).add(nid); }
    }
    const accs: string[] = [];
    for (const ic of [...w.children].filter(e => ln(e) === 'IdentCon')) {
      const au = ic.getAttribute('UId');
      if (au) accs.push(au);
    }
    if (accs.length) nodeAccess[nid] = accs;
  }

  function partOperand(pu: string): string | null {
    const nodes = partNodes[pu];
    if (!nodes) return null;
    for (const n of nodes) {
      const accs = nodeAccess[n];
      if (accs) for (const au of accs) if (access[au]) return access[au];
    }
    return null;
  }

  // RLO propagation as topology tree
  const rlo: Record<string, any> = {};
  for (const n of powerrail) rlo[n] = null; // null = identity (TRUE)

  function seriesAdd(parent: any, node: any): any {
    if (parent === null || parent === undefined) return node;
    if (parent && parent.type === 'series') { parent.items.push(node); return parent; }
    return {type: 'series', items: [parent, node]};
  }
  function parallelOf(nodes: any[]): any {
    const filtered = nodes.filter(n => n !== null && n !== undefined);
    return filtered.length === 1 ? filtered[0] : {type: 'parallel', branches: filtered};
  }

  let changed = true, guard = 0;
  while (changed && guard++ < 64) {
    changed = false;
    // contacts
    for (const [pu, name] of Object.entries(partName)) {
      if (name !== 'Contact' || !partNodes[pu]) continue;
      const power = [...partNodes[pu]].filter(n => !nodeAccess[n]);
      if (power.length !== 2) continue;
      const c = {type: 'contact', operand: partOperand(pu) || '?', negated: !!partNeg[pu]};
      const [a, b] = power;
      if (rlo.hasOwnProperty(a) && !rlo.hasOwnProperty(b)) { rlo[b] = seriesAdd(rlo[a], c); changed = true; }
      else if (rlo.hasOwnProperty(b) && !rlo.hasOwnProperty(a)) { rlo[a] = seriesAdd(rlo[b], c); changed = true; }
    }
    // O parts (parallel)
    for (const [pu, name] of Object.entries(partName)) {
      if (name !== 'O' || !partNodes[pu]) continue;
      const nodes = [...partNodes[pu]];
      const known = nodes.filter(n => rlo.hasOwnProperty(n)).map(n => rlo[n]).filter(n => n !== null && n !== undefined);
      const unknown = nodes.filter(n => !rlo.hasOwnProperty(n));
      if (unknown.length === 1 && known.length >= 1) { rlo[unknown[0]] = parallelOf(known); changed = true; }
    }
  }

  // coils
  for (const [pu, name] of Object.entries(partName)) {
    if (name !== 'Coil' || !partNodes[pu]) continue;
    const power = [...partNodes[pu]].filter(n => !nodeAccess[n]);
    if (power.length !== 1) continue;
    return {coil: partOperand(pu) || '?', negatedCoil: !!partNeg[pu], tree: rlo.hasOwnProperty(power[0]) ? rlo[power[0]] : null};
  }
  return null;
}

function renderNode(n: any): string {
  if (!n) return '';
  if (n.type === 'contact') {
    const neg = n.negated ? '/' : '';
    return `<span class="tia-ct"><span class="tia-bar">|</span>${neg}${n.operand}<span class="tia-bar">|</span></span>`;
  }
  if (n.type === 'series') {
    return `<span class="tia-series">${n.items.map(renderNode).join('<span class="tia-wire">─</span>')}</span>`;
  }
  if (n.type === 'parallel') {
    return `<span class="tia-parallel">${n.branches.map((b: any) => `<span class="tia-series">${renderNode(b)}</span>`).join('')}</span>`;
  }
  return '';
}

function renderRung(r: {coil: string, negatedCoil: boolean, tree: any}): string {
  const neg = r.negatedCoil ? '/' : '';
  return `<div class="tia-rung"><span class="tia-rail">║</span><span class="tia-wire">─</span>${renderNode(r.tree)}<span class="tia-wire">─</span><span class="tia-coil">(${neg}${r.coil})</span></div>`;
}

const CSS = `
.tia-ladder{font-family:ui-monospace,Consolas,monospace;font-size:14px;line-height:1.6}
.tia-rung{display:flex;align-items:center;flex-wrap:wrap;margin:4px 0}
.tia-rail{color:#888;padding:0 3px}
.tia-wire{color:#888}
.tia-series{display:inline-flex;align-items:center}
.tia-parallel{display:inline-flex;flex-direction:column;border-left:2px solid #888;border-right:2px solid #888;margin:0 4px}
.tia-parallel .tia-series{padding:2px 6px}
.tia-ct{display:inline-flex;align-items:center;border:1px solid #666;border-radius:4px;background:#fff;padding:2px 8px;margin:0 3px}
.tia-bar{color:#999;margin:0 2px}
.tia-coil{border:1px solid #070;color:#050;background:#efe;border-radius:10px;padding:2px 10px;margin-left:8px;font-weight:bold}
`;

export const frontendRender: FrontendRenderFunc = async (opts): Promise<boolean> => {
  const xml = opts.contentString();
  if (!/SW\.Blocks\.(FB|FC|OB|DB)/.test(xml)) return false; // not a TIA block

  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const compileUnits = [...doc.getElementsByTagName('*')].filter(e => ln(e) === 'SW.Blocks.CompileUnit');

    const style = document.createElement('style');
    style.textContent = CSS;
    opts.container.appendChild(style);

    const lad = document.createElement('div');
    lad.className = 'tia-ladder';

    let netNum = 0;
    for (const cu of compileUnits) {
      netNum++;
      const flg = [...cu.getElementsByTagName('*')].find(e => ln(e) === 'FlgNet');
      if (!flg) continue;
      const rung = buildRung(flg);
      if (rung) {
        lad.insertAdjacentHTML('beforeend', `<div class="tia-net-label" style="font-weight:bold;margin:8px 0 2px;color:#333">Network ${netNum}</div>`);
        lad.insertAdjacentHTML('beforeend', renderRung(rung));
      }
    }

    if (netNum === 0) return false; // no networks found
    opts.container.appendChild(lad);
    return true;
  } catch (e) {
    console.error('TIA renderer error:', e);
    return false;
  }
};
