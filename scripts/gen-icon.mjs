// Seeded PRNG so the starfield is reproducible
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const rnd = mulberry32(0x9E3779B9);
const W=1024;

// Mushroom paths (kept from the original mark)
const CAP='M256,512 L768,512 A64,64 0 0 0 832,448 C832,88 192,88 192,448 A64,64 0 0 0 256,512 Z';
const STEM='M412,560 L612,560 A32,32 0 0 1 644,592 L672,800 A48,48 0 0 1 624,848 L400,848 A48,48 0 0 1 352,800 L380,592 A32,32 0 0 1 412,560 Z';

// Milky-Way band: diagonal axis top-left -> bottom-right, density falls off perpendicular
const A={x:120,y:140}, B={x:910,y:900};
const dx=B.x-A.x, dy=B.y-A.y, len=Math.hypot(dx,dy);
const ux=dx/len, uy=dy/len;      // along-band unit
const px=-uy, py=ux;             // perpendicular unit

function star(x,y,r,o,fill){return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="${fill}" opacity="${o.toFixed(2)}"/>`;}

const palette=['#FFFFFF','#FFFFFF','#FFFFFF','#FFFFFF','#DCE6FF','#FFE9B8'];
const stars=[];

// Dense band stars (the Milky Way ribbon)
for(let i=0;i<230;i++){
  const t=rnd();                          // position along band
  const along=A.x+dx*t + (rnd()-0.5)*60, alongY=A.y+dy*t + (rnd()-0.5)*60;
  // gaussian-ish perpendicular offset, tight to the band
  const g=(rnd()+rnd()+rnd()-1.5);        // approx normal, sd~0.5
  const off=g*150;
  const x=along+px*off, y=alongY+py*off;
  if(x<24||x>1000||y<24||y>1000) continue;
  const closeness=1-Math.min(1,Math.abs(off)/300);
  const r=1.4+rnd()*rnd()*4.4;
  const o=0.55+closeness*0.45*rnd()+0.18;
  stars.push(star(x,y,r,Math.min(1,o),palette[(rnd()*palette.length)|0]));
}
// Sparse field across the whole canvas
for(let i=0;i<150;i++){
  const x=24+rnd()*976, y=24+rnd()*976;
  const r=1.1+rnd()*rnd()*3.0;
  const o=0.58+rnd()*0.40;
  stars.push(star(x,y,r,o,palette[(rnd()*palette.length)|0]));
}
// A handful of bright "feature" stars with a soft glow — placed only in the
// visible sky around the mushroom (cap ~x[192,832] y[120,512], stem ~x[352,672] y[512,848]),
// so none get hidden behind the gold silhouette.
const skyZones=[
  {x0:70,y0:90,x1:300,y1:470},     // upper-left of the cap
  {x0:724,y0:90,x1:954,y1:470},    // upper-right of the cap
  {x0:70,y0:470,x1:330,y1:900},    // lower-left, beside the stem
  {x0:694,y0:470,x1:954,y1:900},   // lower-right, beside the stem
  {x0:360,y0:60,x1:664,y1:150},    // thin strip across the very top
];
const bright=[];
for(let i=0;i<9;i++){
  const z=skyZones[(rnd()*skyZones.length)|0];
  const x=z.x0+rnd()*(z.x1-z.x0), y=z.y0+rnd()*(z.y1-z.y0);
  bright.push({x,y,r:3.8+rnd()*3.0});
}
// A few extra, slightly larger bright stars in the DISPLAYED top-right corner.
// The starfield is flipped vertically, so displayed-top-right = large x + large data-y;
// keep x>832 so they sit beside the cap (not hidden behind it) and inside the squircle.
const trZone={x0:842,y0:610,x1:946,y1:910};
for(let i=0;i<4;i++){
  const x=trZone.x0+rnd()*(trZone.x1-trZone.x0), y=trZone.y0+rnd()*(trZone.y1-trZone.y0);
  bright.push({x,y,r:4.4+rnd()*3.2});
}
// Relocate the bottom-middle feature star to a balanced spot directly below the
// cap's right edge (cap flat-bottom ends ~x768), centred in the gap between the
// cap bottom (y512) and the stem. Coords are DISPLAYED, then flipped to data space.
const disp=(dx,dy,r)=>({x:dx, y:1024-dy, r});
for(let i=bright.length-1;i>=0;i--){           // drop the old bottom-middle star
  const dy=1024-bright[i].y;
  if(bright[i].x>=480 && bright[i].x<=660 && dy>=880){ bright.splice(i,1); break; }
}
bright.push(disp(772,680,5.6));
// One more in the open sky to the right of the cap: midway between the cap's right
// edge (~x832) and the icon edge (x1024), a touch below the cap bottom (y512).
bright.push(disp(928,548,4.8));

const starsLayer = stars.join('\n    ');
const glowLayer = bright.map(b=>`<circle cx="${b.x.toFixed(1)}" cy="${b.y.toFixed(1)}" r="${(b.r*4).toFixed(1)}" fill="url(#glow)"/>`).join('\n    ');
const brightCores = bright.map(b=>`<circle cx="${b.x.toFixed(1)}" cy="${b.y.toFixed(1)}" r="${b.r.toFixed(2)}" fill="#FFFFFF"/>`).join('\n    ');

const defs = `
  <defs>
    <linearGradient id="gold" x1="312" y1="120" x2="712" y2="848" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FCE38A"/>
      <stop offset="0.5" stop-color="#E6B92E"/>
      <stop offset="1" stop-color="#B07E1C"/>
    </linearGradient>
    <radialGradient id="sky" cx="0.5" cy="0.42" r="0.75">
      <stop offset="0" stop-color="#0E1018"/>
      <stop offset="1" stop-color="#000000"/>
    </radialGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
  </defs>`;

const mushroom = `  <g fill="url(#gold)">
    <path d="${CAP}"/>
    <path d="${STEM}"/>
  </g>`;

// ---- Full composite master (favicon + cargo tauri icon source) ----
// starFlip mirrors the whole starfield vertically so the Milky-Way band runs
// up-and-to-the-right ("/"). The mushroom + background are NOT flipped.
const starFlip = 'transform="translate(0,1024) scale(1,-1)"';
const master = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="64" height="64">${defs}
  <rect width="1024" height="1024" rx="232" fill="url(#sky)"/>
  <g ${starFlip}>
    <g>
      ${starsLayer}
    </g>
    <g>
      ${glowLayer}
      ${brightCores}
    </g>
  </g>
${mushroom}
</svg>
`;

// ---- Layered sources for Icon Composer (.icon) ----
// Each layer is full-bleed 1024 with NO squircle mask — the system masks + supplies glass.
const layerDefs = `
  <defs>
    <linearGradient id="gold" x1="312" y1="120" x2="712" y2="848" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FCE38A"/>
      <stop offset="0.5" stop-color="#E6B92E"/>
      <stop offset="1" stop-color="#B07E1C"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
  </defs>`;

const bg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <radialGradient id="sky" cx="0.5" cy="0.42" r="0.75">
      <stop offset="0" stop-color="#0E1018"/>
      <stop offset="1" stop-color="#000000"/>
    </radialGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#sky)"/>
</svg>
`;

const starsSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${layerDefs}
  <g ${starFlip}>
    <g>
      ${starsLayer}
    </g>
    <g>
      ${glowLayer}
      ${brightCores}
    </g>
  </g>
</svg>
`;

const mushSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${layerDefs}
${mushroom}
</svg>
`;

import {writeFileSync, mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
const root=join(dirname(fileURLToPath(import.meta.url)),'..'); // repo root (scripts/..)
writeFileSync(join(root,'assets/mushroom.svg'), master);
writeFileSync(join(root,'portal/favicon.svg'), master);
writeFileSync(join(root,'portal-app/static/favicon.svg'), master);
mkdirSync(join(root,'assets/icon-layers'),{recursive:true});
writeFileSync(join(root,'assets/icon-layers/1-background.svg'), bg);
writeFileSync(join(root,'assets/icon-layers/2-stars.svg'), starsSvg);
writeFileSync(join(root,'assets/icon-layers/3-mushroom.svg'), mushSvg);
console.log('wrote master + 3 favicons identical + 3 layer sources. stars:',stars.length,'bright:',bright.length);
