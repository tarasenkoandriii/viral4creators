/**
 * Кнопка и окно виджета в Shadow DOM на странице заказчика (ТЗ §3-бис.3,
 * §4.12). Только createElement/textContent/attachShadow; стили —
 * ПОСТОЯННЫЙ лист через adoptedStyleSheets, значения бренда — CSS-переменные
 * через CSSOM (`style.setProperty`), после проверки HEX/enum — никакой
 * конкатенации значений в строку стиля (иначе `red;background:url(//x)`).
 */
import { natives as N } from './natives';
import { onColor, type Icon, type ViewConfig } from '../shared/config';

const SVG = 'http://www.w3.org/2000/svg';
const ICON_PATHS: Record<Exclude<Icon, 'logo'> | 'close', string> = {
  chat: 'M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
  question:
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 16h-2v-2h2v2zm2.1-7.8-.9.9c-.8.8-1.2 1.4-1.2 2.9h-2v-.5c0-1.1.4-2.1 1.2-2.9l1.2-1.3A2 2 0 1 0 10 8H8a4 4 0 1 1 7.1 2.2z',
  headset:
    'M12 2a9 9 0 0 0-9 9v6a3 3 0 0 0 3 3h2v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h2a3 3 0 0 0 3-3v-6a9 9 0 0 0-9-9z',
  close:
    'M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z',
};

const CSS = `:host{all:initial}*{box-sizing:border-box}
.l{position:fixed;z-index:var(--z);width:var(--bs);height:var(--bs);border:0;margin:0;padding:0;border-radius:var(--br);background:var(--c);color:var(--t);cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.24);transition:transform .2s}
.l:focus-visible{outline:3px solid var(--c);outline-offset:3px}
.l svg{width:55%;height:55%;fill:currentColor}.l img{width:62%;height:62%;object-fit:contain}
.p{position:fixed;z-index:var(--z);width:380px;max-width:calc(100vw - 2*var(--x));height:min(640px,calc(100vh - var(--y) - var(--s) - var(--bs) - 28px));min-height:240px;border-radius:var(--pr);overflow:hidden;background:var(--pb);box-shadow:0 12px 40px rgba(0,0,0,.28);transition:opacity .2s}
.p[hidden],.l[hidden]{display:none}
.R .l,.R .p{right:calc(var(--x) + env(safe-area-inset-right,0px))}
.L .l,.L .p{left:calc(var(--x) + env(safe-area-inset-left,0px))}
.B .l{bottom:calc(var(--y) + var(--s) + env(safe-area-inset-bottom,0px))}
.T .l{top:calc(var(--y) + var(--s) + env(safe-area-inset-top,0px))}
.B .p{bottom:calc(var(--y) + var(--s) + var(--bs) + 12px + env(safe-area-inset-bottom,0px))}
.T .p{top:calc(var(--y) + var(--s) + var(--bs) + 12px + env(safe-area-inset-top,0px))}
.N.B .p{bottom:calc(var(--y) + env(safe-area-inset-bottom,0px))}
.N.T .p{top:calc(var(--y) + env(safe-area-inset-top,0px))}
.N .p{height:min(640px,calc(100vh - 2*var(--y)))}
.C .p{top:50%;left:50%;right:auto;bottom:auto;transform:translate(-50%,-50%);height:min(640px,calc(100vh - 32px))}
.M.F .p{left:0;right:0;top:var(--vt,0px);bottom:auto;width:100%;max-width:none;height:var(--vh,100vh);border-radius:0;transform:none}
.M.S .p{left:0;right:0;top:auto;bottom:0;width:100%;max-width:none;height:calc(var(--vh,100vh)*.85);border-radius:16px 16px 0 0;transform:none}
.M.o.F .l,.M.o.S .l{display:none}
.M.U .l{transform:translateY(160%)}.M.U.T .l{transform:translateY(-160%)}
.k{position:absolute;inset:0;background:var(--pb)}.k i{display:block;height:56px;background:var(--c)}
.k b{display:block;margin:16px;height:12px;border-radius:6px;background:rgba(127,127,127,.2)}
iframe{display:block;border:0;width:100%;height:100%;background:transparent}.I iframe{position:absolute;inset:0}
.I{position:relative;width:100%;height:100%;min-height:360px;border-radius:var(--pr);overflow:hidden}
@media (prefers-reduced-motion:reduce){.l,.p{transition:none}}`;

export interface UiLabels {
  open: string;
  close: string;
  frame: string;
}

export interface UiOptions {
  view: ViewConfig;
  inline: Element | null;
  assetUrl: (id: string) => string;
  labels: UiLabels;
  onToggle: () => void;
  onEsc: () => void;
}

function svgIcon(d: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', d);
  svg.appendChild(p);
  return svg;
}

function setClass(el: Element, name: string, on: boolean) {
  el.classList.toggle(name, on);
}

/** Скелет-каркас окна (§4-бис.1: окно в нужном состоянии до загрузки iframe). */
function skeleton(): HTMLElement {
  const k = N.el('div');
  k.className = 'k';
  k.appendChild(N.el('i'));
  for (let n = 0; n < 3; n++) k.appendChild(N.el('b'));
  return k;
}

export class WidgetUi {
  readonly host: HTMLElement;
  readonly root: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly panel: HTMLElement;
  frame: HTMLIFrameElement | null = null;
  private skel: HTMLElement | null = null;
  private opts: UiOptions;
  private view: ViewConfig;
  private shift = 0;

  constructor(opts: UiOptions) {
    this.opts = opts;
    this.view = opts.view;
    this.host = N.el('div');
    this.host.setAttribute('data-v4c', '');
    const sr = N.shadow(this.host);
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      sr.adoptedStyleSheets = [sheet];
    } catch {
      // Старые браузеры без конструируемых листов: <style> с ПОСТОЯННЫМ текстом
      // (под строгим style-src заказчика может не примениться — кнопка всё равно
      // доступна, это лучше, чем требовать 'unsafe-inline').
      const st = N.el('style');
      st.textContent = CSS;
      sr.appendChild(st);
    }
    this.root = N.el('div');
    sr.appendChild(this.root);
    this.button = N.el('button');
    this.button.type = 'button';
    this.button.className = 'l';
    this.button.setAttribute('aria-expanded', 'false');
    N.on(this.button, 'click', () => opts.onToggle());
    this.panel = N.el('div');
    this.panel.className = opts.inline ? 'I' : 'p';
    this.panel.hidden = !opts.inline;
    N.on(sr, 'keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') opts.onEsc();
    });
    if (opts.inline) {
      // Высота — по контейнеру заказчика (мин. 360 px, §3-бис.3).
      this.host.style.setProperty('display', 'block');
      this.host.style.setProperty('height', '100%');
      this.root.style.setProperty('height', '100%');
      this.root.appendChild(this.panel);
      opts.inline.appendChild(this.host);
    } else {
      this.root.appendChild(this.panel);
      this.root.appendChild(this.button);
      (document.body || document.documentElement).appendChild(this.host);
    }
    this.apply(this.view);
  }

  /** Вид → CSS-переменные (CSSOM) и классы. Значения уже проверены (HEX/enum/диапазон). */
  apply(view: ViewConfig) {
    this.view = view;
    const s = this.host.style;
    const b = view.brand;
    const l = view.layout;
    const mobile = this.isMobile();
    const off = mobile ? l.offset.mobile : l.offset.desktop;
    s.setProperty('--c', b.primaryColor);
    s.setProperty('--t', onColor(b.primaryColor, b.buttonTextColor));
    s.setProperty('--z', String(l.zIndex));
    s.setProperty('--x', off.x + 'px');
    s.setProperty('--y', off.y + 'px');
    s.setProperty('--s', this.shift + 'px');
    s.setProperty('--bs', b.preset === 'compact' ? '48px' : '56px');
    s.setProperty('--br', b.preset === 'strict' ? '12px' : '50%');
    s.setProperty(
      '--pr',
      b.preset === 'strict' ? '6px' : b.preset === 'compact' ? '10px' : '16px'
    );
    s.setProperty('--pb', '#ffffff');
    const r = this.root;
    const pos = l.position;
    setClass(r, 'B', pos.indexOf('bottom') === 0);
    setClass(r, 'T', pos.indexOf('top') === 0);
    setClass(r, 'R', pos.slice(-5) === 'right');
    setClass(r, 'L', pos.slice(-4) === 'left');
    setClass(r, 'N', l.launcher === 'none');
    setClass(r, 'C', l.launcher === 'none' && l.openAt === 'center' && !mobile);
    setClass(r, 'M', mobile);
    setClass(r, 'F', l.mobile === 'fullscreen');
    setClass(r, 'S', l.mobile === 'sheet');
    this.button.hidden = l.launcher === 'none' || !!this.opts.inline;
    this.renderIcon();
  }

  isMobile(): boolean {
    return window.matchMedia('(max-width: 640px)').matches;
  }

  private renderIcon() {
    const btn = this.button;
    while (btn.firstChild) btn.removeChild(btn.firstChild);
    const open = this.isOpen();
    btn.setAttribute(
      'aria-label',
      open ? this.opts.labels.close : this.opts.labels.open
    );
    const b = this.view.brand;
    if (open) btn.appendChild(svgIcon(ICON_PATHS.close));
    else if (b.launcherIcon === 'logo' && b.logoAssetId) {
      const img = N.el('img');
      img.alt = '';
      img.src = this.opts.assetUrl(b.logoAssetId);
      btn.appendChild(img);
    } else {
      const icon = b.launcherIcon === 'logo' ? 'chat' : b.launcherIcon;
      btn.appendChild(svgIcon(ICON_PATHS[icon]));
    }
  }

  isOpen(): boolean {
    return this.root.classList.contains('o');
  }

  /** Показать окно; `withSkeleton` — каркас до готовности iframe. */
  show(open: boolean) {
    setClass(this.root, 'o', open);
    if (!this.opts.inline) this.panel.hidden = !open;
    this.button.setAttribute('aria-expanded', String(open));
    if (open && !this.frame && !this.skel) {
      this.skel = skeleton();
      this.panel.appendChild(this.skel);
    }
    this.renderIcon();
  }

  /** iframe чата: ленивый, `referrerpolicy=origin` (iframe узнаёт origin родителя), микрофон — заранее для Э5. */
  ensureFrame(src: string): HTMLIFrameElement {
    if (this.frame) return this.frame;
    if (!this.skel && !this.opts.inline) {
      this.skel = skeleton();
      this.panel.appendChild(this.skel);
    }
    const f = N.el('iframe');
    f.title = this.opts.labels.frame;
    f.setAttribute('referrerpolicy', 'origin');
    f.setAttribute('allow', 'microphone');
    f.src = src;
    this.panel.appendChild(f);
    this.frame = f;
    return f;
  }

  ready() {
    if (this.skel) {
      this.skel.remove();
      this.skel = null;
    }
  }

  /** Скрыть/показать целиком (hide/show API, маски путей, unavailable). */
  visible(on: boolean) {
    this.host.style.setProperty(
      'display',
      on ? (this.opts.inline ? 'block' : '') : 'none'
    );
  }

  setHideOnScroll(hidden: boolean) {
    setClass(this.root, 'U', hidden);
  }

  setVisualViewport(h: number, top: number) {
    this.host.style.setProperty('--vh', h + 'px');
    this.host.style.setProperty('--vt', top + 'px');
  }

  /**
   * «Не перекрывать чужое» (§3-бис.3): ищем в точках кнопки видимые
   * fixed/sticky-элементы страницы (cookie-баннеры, чужие чаты, «наверх»).
   * Пересечение → сдвиг по вертикали на высоту помехи + 12 px; не помещается
   * (выше середины экрана) — соседний угол той же стороны. Возвращает новый
   * угол, если пришлось его сменить.
   */
  avoidOverlap(): string | null {
    const view = this.view;
    const l = view.layout;
    if (
      !l.avoidOverlap ||
      l.launcher === 'none' ||
      this.opts.inline ||
      this.isOpen()
    )
      return null;
    const at = (pos: string, shift: number): DOMRect | null => {
      this.shift = shift;
      this.apply({
        ...view,
        layout: { ...l, position: pos as typeof l.position },
      });
      const r = this.button.getBoundingClientRect();
      if (!r.width) return null;
      const pts: Array<[number, number]> = [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + 2, r.top + 2],
        [r.right - 2, r.top + 2],
        [r.left + 2, r.bottom - 2],
        [r.right - 2, r.bottom - 2],
      ];
      for (const [x, y] of pts) {
        for (const el of document.elementsFromPoint(x, y)) {
          if (
            el === this.host ||
            el === document.body ||
            el === document.documentElement
          )
            continue;
          let e: Element | null = el;
          for (let d = 0; e && d < 6; d++, e = e.parentElement) {
            const cs = getComputedStyle(e);
            if (
              (cs.position === 'fixed' || cs.position === 'sticky') &&
              cs.visibility !== 'hidden'
            )
              return e.getBoundingClientRect();
          }
        }
      }
      return null;
    };
    const pos = l.position;
    const o = at(pos, 0);
    if (!o) return null;
    const r = this.button.getBoundingClientRect();
    const need =
      Math.ceil(
        pos.indexOf('bottom') === 0 ? r.bottom - o.top : o.bottom - r.top
      ) + 12;
    if (
      need + r.height + 2 * r.height < window.innerHeight / 2 &&
      !at(pos, need)
    )
      return null;
    const other = pos.replace(/right|left/, (m) =>
      m === 'right' ? 'left' : 'right'
    );
    if (!at(other, 0)) return other;
    at(pos, need);
    return null;
  }

  focusButton() {
    if (!this.button.hidden) N.focus(this.button);
  }

  destroy() {
    this.host.remove();
  }
}
