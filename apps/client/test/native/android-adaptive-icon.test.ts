/**
 * Regression guard for the Android adaptive launcher icon (v0.1.19).
 *
 * On OnePlus 13T / ColorOS 15 (and stock Android 12+) the Kesoku launcher icon
 * did not switch to its dark variant in Dark Mode because the adaptive icon
 * layers hardcoded light-only hex colors. The fix mirrors the Frosted Charcoal
 * palette used by Play / Podcasts / Books: every icon layer references
 * `@color/ic_launcher_*` resources that are defined in BOTH `values/colors.xml`
 * and `values-night/colors.xml`, and no `mipmap-night-*` overrides exist, so
 * `mipmap-anydpi-v26/ic_launcher.xml` is always used on API 26+.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const RES = resolve(here, '../../android/app/src/main/res');
const read = (p: string) => readFileSync(resolve(RES, p), 'utf8');

function parseColors(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of xml.matchAll(/<color\s+name="([^"]+)">\s*([^<\s]+)\s*<\/color>/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

/** Strip XML comments so documentation text cannot satisfy/violate checks. */
const stripComments = (xml: string) => xml.replace(/<!--[\s\S]*?-->/g, '');

/** All color attribute values (fill/stroke/start/end/item color) in a drawable. */
function colorAttrs(xml: string): string[] {
  return [
    ...stripComments(xml).matchAll(
      /android:(?:fillColor|strokeColor|startColor|centerColor|endColor|color)="([^"]+)"/g,
    ),
  ].map((m) => m[1]);
}

const LIGHT: Record<string, string> = {
  ic_launcher_background: '#F4F1EA',
  ic_launcher_bg_top: '#F8F5EE',
  ic_launcher_bg_mid: '#F4F1EA',
  ic_launcher_bg_bottom: '#EFEADF',
  ic_launcher_bg_glow_start: '#00FFFFFF',
  ic_launcher_bg_glow_mid: '#00FFFFFF',
  ic_launcher_knockout: '#F4F1EA',
  ic_launcher_strap_main: '#E04832',
  ic_launcher_strap_back: '#282D34',
  ic_launcher_leather_tab: '#1E2228',
  ic_launcher_buckle_frame: '#20242A',
  ic_launcher_stitch: '#B494A3B8',
};

const DARK: Record<string, string> = {
  ic_launcher_background: '#282A30',
  ic_launcher_bg_top: '#363940',
  ic_launcher_bg_mid: '#282A30',
  ic_launcher_bg_bottom: '#1E2025',
  ic_launcher_bg_glow_start: '#1AFFFFFF',
  ic_launcher_bg_glow_mid: '#09FFFFFF',
  ic_launcher_knockout: '#282A30',
  ic_launcher_strap_main: '#FB7185',
  ic_launcher_strap_back: '#64748B',
  ic_launcher_leather_tab: '#E2E8F0',
  ic_launcher_buckle_frame: '#F4F6FA',
  ic_launcher_stitch: '#B4475569',
};

const BASE_TOKENS = ['kesoku_bg', 'kesoku_primary', 'kesoku_accent', 'colorPrimary', 'colorPrimaryDark', 'colorAccent'];

describe('Android adaptive icon — frosted dark palette', () => {
  const light = parseColors(read('values/colors.xml'));
  const dark = parseColors(read('values-night/colors.xml'));

  it('values/colors.xml defines the exact light launcher palette', () => {
    for (const [name, hex] of Object.entries(LIGHT)) expect(light[name], name).toBe(hex);
  });

  it('values-night/colors.xml defines the exact Frosted Charcoal dark palette', () => {
    for (const [name, hex] of Object.entries(DARK)) expect(dark[name], name).toBe(hex);
  });

  it('keeps the existing web design tokens in both palettes', () => {
    for (const name of BASE_TOKENS) {
      expect(light[name], `light ${name}`).toMatch(/^#[0-9A-F]{6}$/i);
      expect(dark[name], `dark ${name}`).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it('every icon color actually changes between light and dark', () => {
    for (const name of Object.keys(DARK)) {
      expect(dark[name], name).not.toBe(light[name]);
    }
  });
});

describe('Android adaptive icon — drawables reference night-aware colors', () => {
  it('ic_launcher_background.xml is the 2-layer frosted-glass vector', () => {
    const xml = stripComments(read('drawable/ic_launcher_background.xml'));
    const paths = [...xml.matchAll(/<path android:pathData="M0,0h108v108h-108z">([\s\S]*?)<\/path>/g)].map((m) => m[1]);
    expect(paths).toHaveLength(2);

    const [linear, radial] = paths;
    expect(linear).toContain('<aapt:attr name="android:fillColor">');
    expect(linear).toContain('android:type="linear"');
    for (const attr of ['startX="54"', 'startY="16"', 'endX="54"', 'endY="92"']) expect(linear).toContain(`android:${attr}`);
    const linearStops = [...linear.matchAll(/android:color="([^"]+)"\s+android:offset="([^"]+)"/g)].map((m) => [m[1], m[2]]);
    expect(linearStops).toEqual([
      ['@color/ic_launcher_bg_top', '0.0'],
      ['@color/ic_launcher_bg_mid', '0.48'],
      ['@color/ic_launcher_bg_bottom', '1.0'],
    ]);

    expect(radial).toContain('android:type="radial"');
    for (const attr of ['centerX="48"', 'centerY="32"', 'gradientRadius="46"']) expect(radial).toContain(`android:${attr}`);
    const radialStops = [...radial.matchAll(/android:color="([^"]+)"\s+android:offset="([^"]+)"/g)].map((m) => [m[1], m[2]]);
    expect(radialStops).toEqual([
      ['@color/ic_launcher_bg_glow_start', '0.0'],
      ['@color/ic_launcher_bg_glow_mid', '0.55'],
      ['#00FFFFFF', '1.0'],
    ]);
  });

  it('background has no hardcoded opaque colors (only the transparent radial tail)', () => {
    const colors = colorAttrs(read('drawable/ic_launcher_background.xml'));
    expect(colors.filter((c) => c.startsWith('#'))).toEqual(['#00FFFFFF']);
  });

  for (const file of ['drawable/ic_launcher_foreground.xml', 'drawable/ic_splash_mark.xml']) {
    it(`${file} uses only @color/ic_launcher_* references`, () => {
      const colors = colorAttrs(read(file));
      expect(colors.length).toBeGreaterThan(0);
      for (const c of colors) {
        expect(c, `${file}: ${c}`).toMatch(/^@color\/ic_launcher_[a-z_]+$/);
      }
      // Each referenced color must exist in both light and night palettes.
      const light = parseColors(read('values/colors.xml'));
      const dark = parseColors(read('values-night/colors.xml'));
      for (const c of new Set(colors)) {
        const name = c.slice('@color/'.length);
        expect(light[name], `light ${name}`).toBeDefined();
        expect(dark[name], `dark ${name}`).toBeDefined();
      }
    });
  }

  it('foreground references every K-mark color role', () => {
    const colors = new Set(colorAttrs(read('drawable/ic_launcher_foreground.xml')));
    for (const role of ['strap_back', 'leather_tab', 'stitch', 'knockout', 'strap_main', 'buckle_frame']) {
      expect(colors.has(`@color/ic_launcher_${role}`), role).toBe(true);
    }
  });

  it('mipmap-anydpi-v26 adaptive icons use the vector layers + monochrome', () => {
    for (const f of ['mipmap-anydpi-v26/ic_launcher.xml', 'mipmap-anydpi-v26/ic_launcher_round.xml']) {
      const xml = read(f);
      expect(xml).toContain('<background android:drawable="@drawable/ic_launcher_background" />');
      expect(xml).toContain('<foreground android:drawable="@drawable/ic_launcher_foreground" />');
      expect(xml).toContain('<monochrome android:drawable="@drawable/ic_launcher_monochrome" />');
    }
  });

  it('no mipmap-night-* folders shadow the adaptive icon', () => {
    expect(existsSync(RES)).toBe(true);
    const nightMipmaps = readdirSync(RES).filter((d) => d.startsWith('mipmap-night'));
    expect(nightMipmaps).toEqual([]);
  });
});
