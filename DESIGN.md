# DESIGN.md — "Neon Terminal" Design System

A framework-agnostic design specification extracted from the LSO KALIBER landing page (`LSO-Kaliber/Landing_EP`, Vue 3 + Tailwind CSS 3). Follow it to build any site that looks the same or very close. All values come from the source code; the brand-specific parts (logo, copy, mascot) are marked **[swap]**.

---

## 1. Design Identity

| | |
|---|---|
| **Concept** | Cybersecurity / hacker-terminal aesthetic: dark grain background, white text with soft neon glow, a single crimson accent |
| **Mood** | Dark, techy, glowing, slightly retro-futuristic |
| **Signature moves** | (1) glow via `text-shadow` on nearly all text, (2) red→deep-purple gradient cards, (3) monospace UPPERCASE body copy, (4) circuit-style SVG dividers, (5) chamfered button plate with white brackets, (6) scrolling marquee rows |
| **Theme** | Dark only. No light mode. |
| **Grid** | Mobile-first. One breakpoint matters: `md` = 768px |

---

## 2. Design Tokens

### 2.1 Color

| Token | Hex | Usage |
|---|---|---|
| `--bg` | `#161a1d` | `html` background (under the grain texture) |
| `--fg` | `#ffffff` | All primary text, with glow |
| `--accent` | `#e5383b` | Highlighted words, borders, tags, focus rings, glow, scrollbar thumb, divider accents |
| `--accent-hover-light` | `#ff898b` | Hover for accent text links on the landing page |
| `--accent-hover-dark` | `#bd2326` | Hover for accent links on error pages |
| `--accent-deep` | `#b30000` | Scrollbar thumb hover |
| `--card-from` | `#c83338` | Card gradient start (crimson) |
| `--card-to` | `#291c33` | Card gradient end (deep purple) |
| `--profile-to` | `#211c36` | Profile banner gradient end (paired with `#e5383b`) |
| `--btn-from` | `#e5383b` | Button plate gradient start |
| `--btn-to` | `#fae1dd` | Button plate gradient end (pale pink) |
| `--glow-pink` | `#fa4c58` | Hero background glow circle |
| `--glow-cream` | `#fae1dd` | Hero background glow circle |
| `--fg-muted` | `rgba(255,255,255,0.6–0.8)` | Secondary text (`opacity-60` / `opacity-80`) |
| `--accent-tint` | `rgba(229,56,59,0.10)` | Tinted fills (profile tags, about box) |
| `--field-bg` | `rgba(0,0,0,0.25)` | Form field background |

Gradients:
```css
--grad-card:    linear-gradient(to bottom right, #c83338, #291c33);  /* Cards, mobile menu */
--grad-card-h:  linear-gradient(to right,        #c83338, #291c33);  /* Content / Contributor / Resource cards */
--grad-profile: linear-gradient(to bottom right, #e5383b, #211c36);  /* Profile banner */
--grad-button:  linear-gradient(to right,        #e5383b, #fae1dd);  /* Button plate (SVG) */
```

Rule: **white + one red**. Do not introduce other hues. Red is for emphasis, white for everything else.

### 2.2 Glow (the signature effect)

| Level | CSS | Use |
|---|---|---|
| Heading glow | `text-shadow: 0 0 8px #fff` | H1/H2, marquee, nav hover, footer headings |
| Body glow | `text-shadow: 0 0 4px #fff` | Paragraphs, labels, tags |
| Soft glow | `text-shadow: 0 0 2px #fff` | Card descriptions |
| Accent glow | `text-shadow: 0 0 4px #e5383b` | Red highlighted words, inputs, tag hex text |
| Strong accent glow | `text-shadow: 0 0 8px #e5383b` | Big red titles (e.g. org name) |
| Image glow | `filter: drop-shadow(0 0 8px #fff)` | Avatars, profile name, embedded video (`0 0 20px #fff`) |
| Card glow | `filter: drop-shadow(0 0 10px #e5383b)` | Content cards |
| Footer rule | `box-shadow: 0 0 100px 10px #e5383b; border-top: 1px solid #e5383b` | Final `<hr>` |
| Card hover | `box-shadow: 0 10px 20px rgba(200,51,56,.3)` | Resource / contributor cards |

### 2.3 Typography

| Role | Font | Source |
|---|---|---|
| **Display / wordmark** | `STOP` (stencil style) | Brand wordmark in navbar **[swap]** |
| **Hero title** | `Agency FB Bold` | Condensed; used once for the big hero title |
| **Headings** | `PT Sans Bold` | All H1/H2, marquee, card titles |
| **Body / UI / nav / buttons / forms** | `Hack` (Regular + Bold) | Monospace, almost all copy, **UPPERCASE** |
| **Secondary text** | `PT Sans` Regular / Italic | Profile meta, tags |

```css
@font-face { font-family: "AgencyFB";     src: url("fonts/AgencyFB-Bold.ttf"); }
@font-face { font-family: "Hack-Regular"; src: url("fonts/hack/hack-regular.woff"); }
@font-face { font-family: "Hack-Bold";    src: url("fonts/hack/hack-bold.woff"); }
@font-face { font-family: "PTSans-Regular"; src: url("fonts/pt_sans/PTSans-Regular.ttf"); }
@font-face { font-family: "PTSans-Italic";  src: url("fonts/pt_sans/PTSans-Italic.ttf"); }
@font-face { font-family: "PTSans-Bold";    src: url("fonts/pt_sans/PTSans-Bold.ttf"); }
@font-face { font-family: "Stop";         src: url("fonts/STOP.ttf"); }
```

> **License check:** Hack (MIT-style) and PT Sans (OFL) are free. **Agency FB** is a commercial font (ships with MS Office) and **STOP** has no license info in the repo. Verify before using on a new public site, or substitute: Agency FB → *Teko* / *Oswald*; STOP → any stencil display font. Add `font-display: swap`; prefer the `.woff2` files already in the repo.

Type scale (mobile → desktop `md`):

| Element | Mobile | Desktop | Font | Notes |
|---|---|---|---|---|
| Page hero title (About, Content) | 20px | 150px | PT Sans Bold | heading glow |
| Landing hero title | 40px | ~96px (`text-8xl`) | Agency FB | `tracking-wider`, heading glow |
| Section H1 | 20px | 60px | PT Sans Bold | heading glow, centered on mobile |
| Sub-section H1 | 20px | 45px | PT Sans Bold | |
| Role heading (contributors) | 18–28px | 38px | PT Sans Bold | |
| Org title (welcome page) | 40px | 98px | PT Sans Bold | **red** + strong red glow |
| Marquee | 20px | 140px | PT Sans Bold | `tracking-wider`, heading glow |
| Body paragraph | 12px | 20px | Hack | UPPERCASE, justified, body glow |
| Lead label (e.g. "ABOUT") | 15px | 22px | Hack Bold | |
| Nav link | 16px | 20px | Hack | |
| Footer heading | 14px | 20px | Hack semibold | UPPERCASE |
| Footer link | 12px | 16px | Hack | |
| Footer copyright | 10px | 16px | Hack | |
| Button label | 11px | 15px | Hack Bold | black, white on hover |
| Card title | 20px | 30px | PT Sans Bold | `tracking-tight` |
| Card body | 10px | 20px | Hack | |
| Error code | 18px | 30px | Hack | |

Text conventions:
- Body copy is **UPPERCASE** Hack, `text-align: justify`, with `margin-inline: 40px` (`mx-10`).
- Emphasised words inside a paragraph: `color:#e5383b; text-shadow:0 0 4px #e5383b`.
- Headings: white, bold, centered on mobile, left/justified on desktop.
- Antialiasing: `-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale` on the app root.

### 2.4 Spacing & Layout

- **Container:** Tailwind `container mx-auto` (max-width steps 640 / 768 / 1024 / 1280 / 1536), no extra padding.
- **Horizontal gutter for text blocks:** `40px` (`mx-10`). Footer uses `16px` mobile / `40px` desktop.
- **Section rhythm:** divider line, then `mt-8 md:mt-28` to the section Tag, `mb-16 md:mb-32` to the next divider. Between button and next paragraph: `my-16`.
- **Page structure (every page):** `Navbar` → hero → `Divider` → section(s) separated by `Divider` → `Footer`.
- **Wrapper background:** `#161a1d` + tiled `grain-dark.png` (400×400 RGBA noise) on the page wrapper.
- **Radius:** `rounded-md` (6px) mobile / `rounded-2xl` (16px) desktop for cards; `rounded-xl` (12px) for panels; `rounded-lg` (8px) for inputs and photos; pill = `rounded-[50px]` for profile tags.
- **Breakpoint behavior:** mobile = single column, small text, decorative hero art hidden (`w-0` / `invisible`); `md` = multi-column, large type, decorative art visible.

### 2.5 Motion

| Effect | Spec |
|---|---|
| Nav link hover | glow to `0 0 8px #fff`, `transition: all .7s` |
| Button hover | `translateY(-4px)` + label turns white, `300ms` |
| Big card hover | `translateY(-16px)` mobile / `-40px` desktop, `300ms ease-in-out` |
| Small card hover | `translateY(-2px)` + red box-shadow, `.3s ease` |
| Tag hover | fill turns `#e5383b`, `500ms` |
| Text link hover | colour to `#ff898b`, `500ms` |
| Marquee | 10s linear infinite; row 1 scrolls left, row 2 scrolls right |
| Blinking status | Tailwind `animate-pulse` on `>> REGISTRATION IS CLOSED.` and on "CLICK TO ACCESS" |
| Input focus | 4px red inset ring + `animate-pulse` |
| Page transition | `.fade-enter-active, .fade-leave-active { transition: opacity .5s ease } .fade-enter-from, .fade-leave-to { opacity: 0 }` |
| Photo reveal | `blur-sm` → `blur-none` on hover, `1000ms` |
| Spinner | 80px dual-ring, white, `1.2s linear infinite` |
| Starfield (optional) | 6 layers of 1–2px white dots via huge `box-shadow` lists, translating up `-2000px` over 50–200s |

Respect `prefers-reduced-motion`: disable marquee, pulse and starfield.

---

## 3. Components

### 3.1 Navbar
- Row: logo (`40px` high mobile, `54px` ≥sm) + wordmark (`STOP` font, `25px`, white) on the left; links on the right.
- Links: `HOME · ABOUT · CONTENT · CHALLENGE` in Hack, white, uppercase; hover = heading glow.
- **Mobile:** hamburger button (white icon, `focus:ring-2 ring-white`), toggles a dropdown panel: `absolute top-14`, full width, `grad-card`, `rounded-xl`, `p-4`, stacked links.
- **Desktop:** no visible panel; links sit inline with `32px` spacing. Background transparent.

### 3.2 Tag (section marker)
Pixel-style `#` icon (SVG, red squares with glow) + red text in Hack (`12px` / `20px`, accent glow). The text here is the hex of the org name (`6B616C69626572` = "kaliber") **[swap]**. Placed left-aligned (`ml-10`) above each section heading.

### 3.3 Divider ("Line")
Full-width SVG, white `0.5px` stroke with blur glow: horizontal line that dips down in the middle with two short thick ticks (circuit trace). Footer uses a heavier variant of alternating white and `#e5383b` dashes.

Simplified inline version:
```html
<svg viewBox="0 0 1452 44" width="100%" fill="none" style="filter:drop-shadow(0 0 4px #fff)">
  <path d="M6 7H506L541 37H911L946 7H1446" stroke="#fff" stroke-width="0.5"/>
  <path d="M546 22H673" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
  <path d="M779 22H906" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
</svg>
```

### 3.4 Button (chamfered plate)
SVG plate `371×80` with a gradient fill and notched top/bottom edges, plus white corner brackets on both sides. Label centered on top: Hack Bold, `#000`, uppercase; hover → white label and `-4px` lift.
```html
<svg viewBox="0 0 371 80" fill="none">
  <defs><linearGradient id="g" x1="15" x2="356" y1="38" y2="38" gradientUnits="userSpaceOnUse">
    <stop stop-color="#E5383B"/><stop offset="1" stop-color="#FAE1DD"/></linearGradient></defs>
  <path d="M15 14H51.18L89.84 18.63H281.41L320.07 14H356.25V64H320.07L281.41 59.37H89.84L51.18 64H15Z" fill="url(#g)"/>
  <path d="M340 5H366V75H340M31 5H5V75H31" stroke="#fff"/>
</svg>
```
Width: `75%` of container on mobile, intrinsic on desktop. Three variants share the look: router link, external anchor, `<button>`.

### 3.5 Info Card (large)
`650px` wide desktop / `300px` mobile, `rounded-xl`, `padding 12px 32px`, `grad-card` diagonal. Title PT Sans Bold, body Hack uppercase justified, decorative binary-digits SVG (red + purple) at the bottom. Hover lifts strongly (see Motion). Cards sit in a wrapping flex row, `justify-evenly`, `margin 8px / 16px`.

### 3.5b Content Card
`400×550`, `rounded-2xl`, `grad-card-h`, red `drop-shadow(0 0 10px #e5383b)`. Inside: `350×200` rounded image (top padding 32px), title (Hack Bold 18px, glow, underline on hover), reading time (Hack 14px), then tag chips.

### 3.6 Resource Card
`w-full md:w-80`, `h-28 md:h-40`, `rounded-md md:rounded-2xl`, `grad-card-h`, `padding 12px`. Title PT Sans Bold (16/24px, heading glow), description Hack at 80% opacity, then `>> CLICK TO ACCESS <<` pulsing at 60%. Binary SVG strip at the bottom. Hover: `-2px` + red shadow.

### 3.7 Contributor Card
Same gradient and hover as Resource Card; row layout: avatar (`28px` mobile / `64px` desktop, rounded, white glow) + username in Hack. Grouped under role headings, centered, `8–16px` gaps.

### 3.8 Content Tag (chip)
Square chip: `3px solid #e5383b`, white text `14px` with glow, `padding 4px 8px`, hover fills red (`500ms`).

### 3.9 Category Card
`4px` red border box, left a `15px` circle with a `4px` red border, then Hack text with glow.

### 3.10 Profile elements
- **Banner:** `grad-profile` (`160px` / `320px` high) with a circuit-board SVG pattern overlay, repeating.
- **Photo frame:** white at 20% opacity, `rounded-lg/xl`, `154×164` mobile / `300×300` desktop, inner photo blurred until hover.
- **Name:** PT Sans Bold `24px` / `68px`, white glow.
- **Meta row:** PT Sans, white at 60%, `10/20px`.
- **Interest pill:** `#e5383b` at 10% fill, `1px` (mobile) / `2px` (desktop) red border, `rounded-xl` / `rounded-[50px]`, PT Sans white `8/20px`.
- **About box:** same tinted fill and border, `rounded-xl/2xl`, label "ABOUT" in Hack (`18/40px`, soft glow), text Hack `10/20px`.

### 3.11 Form Field
- Label: Hack white `12/20px`; required marker `*` in red.
- Field: full width, height `32px` / `48px`, `rounded-md/lg`, padding `8/16px`, background `rgba(0,0,0,.25)`, `1px` inset white ring, **text and placeholder in `#e5383b`** with accent glow, Hack font.
- Focus: `4px` inset red ring + pulse.
- Error text: red, Hack `8/12px`, hidden until invalid.
- Layout: two columns on desktop (`gap 16px`), one on mobile. Dropdowns use the same style.
- hCaptcha widget: `theme="dark"`, `size="compact"`.

### 3.12 Footer
`4` columns on desktop (brand+copyright / CONTACT / FOLLOW / LEGAL), single column on mobile where each list item has a `1px` white bottom border. Headings Hack semibold uppercase with heading glow; links Hack white. Heavy divider above and glowing red `<hr>` below. Icons: Font Awesome (location-dot, phone, at, envelope, check, xmark, search, spinner).

### 3.13 Marquee Banner
Two stacked rows (`h-32px` mobile / `160px` desktop), `overflow:hidden`. Each row holds a `200%`-wide track with the phrase duplicated twice (each copy `50%` wide). Row 1 animates `left: 0 → -100%`, row 2 animates `right: 0 → -100%`, `10s linear infinite`. Text: PT Sans Bold, white, heading glow, ends with `•`.

```css
.marquee { width:100%; overflow:hidden; position:relative; }
.marquee--inner, .marquee--outer { display:block; width:200%; position:absolute; }
.marquee--inner { animation: marquee-in 10s linear infinite; }
.marquee--outer { animation: marquee-out 10s linear infinite; }
.marquee--inner > *, .marquee--outer > * { float:left; width:50%; }
@keyframes marquee-in  { from { left:0 }  to { left:-100% } }
@keyframes marquee-out { from { right:0 } to { right:-100% } }
```
> Scope the `float/width` rule to the marquee children; the original applies it to every `span` on the page.

### 3.14 Status pages (404 / 503 / success)
Centered column: `wOops !` (PT Sans Bold, `30/60px`, glow) → illustration SVG (`256px` / `25%` wide) → `ERR 404 : PAGE NOT FOUND` (Hack `18/30px`, glow) → explanation (Hack `11/20px`) with red highlighted phrase, red links to HOMEPAGE and CONTACT US (hover `#bd2326`). Success page: white check icon at `18/50px`, Hack Bold message.

### 3.15 Misc
- **Scrollbar:** thumb `#e5383b` (hover `#b30000`), `20px` radius; track with `inset 0 0 5px grey`, `10px` radius.
- **Loading:** white dual-ring spinner centered with large vertical margin.
- **Powered-by row:** brand SVGs (`96–192px` wide) in a row, white, glow + `drop-shadow(0 0 4px #fff)` on hover.
- **Embedded video:** `rounded-xl/2xl`, `drop-shadow(0 0 20px #fff)`, `200px` high mobile / `600×350` desktop.

---

## 4. Page Patterns

**Landing:** Navbar → hero (big blurred art behind, org logo, title, "Powered by" logos, pulsing status line) → Divider → marquee (two rows) → About (label, paragraph, CTA button, paragraph, text link with arrow) → Divider → "Prepare" section (Tag, H1, paragraph, CTA, 2 Info Cards, Tag, mascot sprite, H1, hashtags line, CTA) → Footer.

**About:** huge page title → Divider → lore section with Tag + H1 + two paragraphs + video → Divider → Contributors grouped by role → thank-you line → Footer.

**Content:** huge page title → Divider → Tag + H1 + Resource Cards row (column on mobile) → Footer.

**Profile:** gradient banner with pattern → overlapping photo frame + name → meta row → status • id line → interest pills → About box → Footer.

**Registration:** intro paragraphs + CTA button → Divider → two-column form with captcha and submit button.

---

## 5. Background & Imagery

- **Texture:** `grain-dark.png`, 400×400 tiled noise over `#161a1d`.
- **Hero art:** a large dark network/cover illustration, `75%` width, absolutely positioned `-240px` from top, behind content (`z-index:-10`), plus two blurred glow circles (`#fae1dd` and `#fa4c58`, radius 70, blur 150, `60%` opacity) offset to the right. Hidden on mobile.
- **Binary strips:** SVG of 0/1 digits in `#e5383b` and `#211c36`, used as decoration at the bottom of cards, and a large red binary ornament behind the "About" label.
- **Mascot / pixel sprite:** pixel-art character, centered, `192px` mobile / `20%` desktop **[swap]**.
- **Logo:** square PNG with transparent background **[swap]**.

---

## 6. Rebuild Recipe

### Tailwind config
```js
module.exports = {
  content: ["./public/**/*.html", "./src/**/*.{vue,js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: { accent: "#e5383b", crimson: "#c83338", plum: "#291c33", ink: "#161a1d" },
      fontFamily: {
        agencyfb: ["AgencyFB", "sans-serif"],
        hack: ["Hack-Regular", "monospace"],
        "hack-bold": ["Hack-Bold", "monospace"],
        "pt-sans": ["PTSans-Regular", "sans-serif"],
        "pt-sans-italic": ["PTSans-Italic", "sans-serif"],
        "pt-sans-bold": ["PTSans-Bold", "sans-serif"],
        stop: ["Stop", "monospace"],
      },
    },
  },
};
```

### Plain CSS tokens
```css
:root {
  --bg:#161a1d; --fg:#fff; --accent:#e5383b;
  --card-from:#c83338; --card-to:#291c33;
  --glow-h:0 0 8px #fff; --glow-b:0 0 4px #fff; --glow-a:0 0 4px #e5383b;
}
html { background: var(--bg); }
body { color: var(--fg); font-family: "Hack-Regular", monospace; background-image: url(grain-dark.png); }
h1,h2 { font-family: "PTSans-Bold", sans-serif; text-shadow: var(--glow-h); }
p { text-transform: uppercase; text-align: justify; text-shadow: var(--glow-b); margin-inline: 40px; }
.hl { color: var(--accent); text-shadow: var(--glow-a); }
.card { background: linear-gradient(to bottom right, var(--card-from), var(--card-to)); border-radius: 12px; transition: transform .3s ease-in-out; }
.card:hover { transform: translateY(-16px); }
::-webkit-scrollbar-thumb { background: var(--accent); border-radius: 20px; }
::-webkit-scrollbar-thumb:hover { background: #b30000; }
```

### Prompt for AI builders
> Build a dark, cyber-terminal website. Background `#161a1d` with tiled grain texture. All text white with a soft white `text-shadow` glow; headings in PT Sans Bold, body in Hack monospace, uppercase and justified. One accent colour, `#e5383b`, used for highlighted words, tags, focus rings and a red glow. Cards use a diagonal gradient from `#c83338` to `#291c33`, rounded corners, and lift on hover. Sections are separated by a thin white circuit-trace SVG divider. Buttons are a chamfered gradient plate (`#e5383b` → `#fae1dd`) with white corner brackets and black Hack Bold labels. Include a two-row scrolling marquee, pixel `#` section tags, a four-column footer, and a glowing red rule at the bottom. Mobile-first with a single `md` (768px) breakpoint.

---

## 7. Do / Don't

**Do**
- Keep a single red accent on white-on-dark; glow every text element at the right level.
- Use uppercase Hack for body, PT Sans Bold for headings, and keep the three-tier glow hierarchy.
- Separate sections with the divider SVG, and give each section a Tag, H1, paragraph, CTA in that order.

**Don't**
- Add extra accent colors, light mode, or flat unglowing text.
- Use sharp 90° corners on cards (except the square tag chips and category box).
- Place hero art on mobile (it is hidden below `md`).

---

## 8. Known Issues in the Source (fix when you rebuild)

1. **Tiny mobile text:** form text at `8px`, error text `8px`, contributor names `8px`, tags `8px`. Use at least `12–14px`; keep `16px` for form fields (also prevents iOS zoom).
2. **Justified, all-caps, glowing body copy** reduces readability for long text; keep for short blocks, switch to left-aligned sentence case for long paragraphs.
3. **Contrast:** red `#e5383b` text on `#161a1d` is about 4.1:1, below the 4.5:1 AA threshold for small text (the glow helps but does not count). Use it for emphasis and large text, not for long copy; consider a lighter red such as `#ff898b` for small red text, and avoid red-only input text.
4. **Global `span { float:left; width:50% }`** (marquee) leaks everywhere; scope it.
5. **Typos / invalid utilities:** `flex-warp` (should be `flex-wrap`), `md:to-[255,255,255,0]` (invalid), `class="transparent"` (not a Tailwind class), duplicated `pt-sans-bold` key, duplicate `id="text"` and `id="marquee2-inv"` (use classes), `<t>` tags (not valid HTML; use `<span class="hl">`), `.container{position:relative}` overrides Tailwind's container.
6. **Conflicting sizes:** hero title declares both `md:text-[48px]` and `md:text-8xl`; pick one.
7. **Cards and chips have fixed pixel widths** (`400×550`, `650px`); make them fluid for small screens.
8. **Alt text:** many images have empty or generic `alt`; add meaningful text. Add `aria-label` to icon-only controls and respect `prefers-reduced-motion`.
9. **Do not commit `.env` or IDE folders** (`.vs/`) to the new repo.
10. **Assets:** hero/cover SVG embeds a 4096² base64 PNG (large). Export it as an optimized WebP/AVIF instead.
