/** Own vector artwork and silent reusable master. No external images, voice or paid generation. */
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const require = createRequire(new URL('../backend/package.json', import.meta.url));
const { Resvg } = require('@resvg/resvg-js');
const dir = new URL('../frontend/public/story-assets/turnip-v1/', import.meta.url);
await mkdir(dir, {recursive:true});
if(!process.argv.includes('--replace-unpublished')) {
  try { await readFile(new URL('manifest.json',dir)); throw new Error('Published revisions are immutable: create a new revision. For an unreleased local draft only use --replace-unpublished.'); } catch(e) {if(e.code!=='ENOENT')throw e;}
}
const fps=25, seconds=55.76, frames=Math.round(fps*seconds);
const cuts=[0,7,15,23,33,45,seconds];
const subtitles=['Посадил дед репку','Тянет-потянет…','Бабка за дедку','Внучка за бабку','Жучка и Машка на помощь','Мышка помогла — вытащили репку!'];
const human=(x,y,kind,phase)=>{
 const granny=kind==='granny', child=kind==='child', scale=child?.72:1;
 const dress=granny?'#bc6f5d':child?'#d1a741':'#677b89';
 return `<g transform="translate(${x} ${y}) scale(${scale}) rotate(${Math.sin(phase)*1.6})"><path d="M-12 60L-24 102M12 60L29 102" stroke="#46555b" stroke-width="13" stroke-linecap="round"/><path d="M-28 102H-7M17 102H40" stroke="#443d3b" stroke-width="13" stroke-linecap="round"/><path d="M-26-5Q0-22 27-5L34 68H-33Z" fill="${dress}"/><path d="M-24 5L-51 25L-71 18M24 7L45 25L65 20" fill="none" stroke="${dress}" stroke-width="15" stroke-linecap="round"/><circle cx="0" cy="-39" r="29" fill="#efc6a0"/>${granny?'<path d="M-31-40Q-29-88 9-76Q40-73 31-37L11-59L-28-40Z" fill="#d8a090"/><path d="M-28-33L-35-7L-13-19M29-33L37-7L15-19" fill="#d8a090"/>':child?'<path d="M-29-43Q-20-84 10-68Q36-61 30-39L4-58Z" fill="#8c5a38"/><path d="M24-59Q55-83 46-40" fill="#8c5a38"/>':'<path d="M-37-53H36L28-65H-27Z" fill="#d5b782"/><path d="M-23-64L-19-79H23L27-64Z" fill="#bfa16b"/><path d="M-21-22Q0 14 23-22L13-10L0-15L-12-10Z" fill="#f8f0df"/>'}<circle cx="-10" cy="-40" r="2.5" fill="#48443d"/><circle cx="10" cy="-40" r="2.5" fill="#48443d"/><path d="M-7-26Q0-22 8-26" fill="none" stroke="#b67763" stroke-width="2" stroke-linecap="round"/></g>`;
};
const animal=(x,y,kind,phase)=>{
 const cat=kind==='cat',mouse=kind==='mouse', s=mouse?.46:cat?.72:1;
 return `<g transform="translate(${x} ${y}) scale(${s}) rotate(${Math.sin(phase)*2})"><path d="M-30 22L-40 55M24 22L33 55" stroke="${cat?'#9d9183':mouse?'#aaa49a':'#936c50'}" stroke-width="12" stroke-linecap="round"/><ellipse cx="0" cy="15" rx="39" ry="25" fill="${cat?'#b4a493':mouse?'#bdb6aa':'#b78b66'}"/><path d="M33 8Q70-12 55-34" fill="none" stroke="${cat?'#b4a493':mouse?'#bdb6aa':'#b78b66'}" stroke-width="9" stroke-linecap="round"/><circle cx="-30" cy="-17" r="24" fill="${cat?'#c3b29d':mouse?'#c7c1b6':'#c69770'}"/>${cat?'<path d="M-51-26L-54-57L-29-37L-11-55L-10-22" fill="#c3b29d"/>':mouse?'<circle cx="-45" cy="-40" r="16" fill="#b2a99c"/><circle cx="-14" cy="-38" r="16" fill="#b2a99c"/>':'<path d="M-46-27Q-71-41-61-8Q-54 2-48-10Z" fill="#805a45"/>'}<circle cx="-37" cy="-18" r="3" fill="#41433c"/><circle cx="-53" cy="-5" r="5" fill="#51483e"/><path d="M-48 1Q-40 6-34 1" fill="none" stroke="#705b4a" stroke-width="2"/></g>`;
};
function scene(t,cover=false){
 let k=Math.min(5,cuts.findIndex((v,i)=>i<6&&t>=v&&t<cuts[i+1]));if(k<0)k=5;
 const pull=Math.sin(t*3),rise=k===5?Math.min(1,(t-45)/5)*65:0;
 return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#e9efe5"/><stop offset="1" stop-color="#f8efd9"/></linearGradient><linearGradient id="earth" x2="0" y2="1"><stop stop-color="#d6bb94"/><stop offset="1" stop-color="#b69570"/></linearGradient></defs><rect width="1280" height="720" fill="url(#sky)"/><circle cx="1095" cy="145" r="59" fill="#edcd7d" opacity=".65"/><g fill="#fffaf0" opacity=".9"><ellipse cx="${210+t*.5}" cy="150" rx="96" ry="24"/><ellipse cx="${260+t*.5}" cy="130" rx="50" ry="34"/><ellipse cx="${850-t*.3}" cy="205" rx="105" ry="22"/></g><path d="M0 360Q200 290 420 360T800 350T1280 330V720H0" fill="#b5c4a2"/><path d="M0 440Q240 370 460 430T900 420T1280 410V720H0" fill="#96ae8d"/><g transform="translate(105 275)"><rect y="65" width="160" height="135" rx="9" fill="#e6ceb0"/><path d="M-22 73L75-5L180 73" fill="#bc8064"/><rect x="22" y="100" width="43" height="40" rx="4" fill="#81a5a3"/><path d="M43 100V140M22 120H65" stroke="#f5e7d2" stroke-width="4"/><rect x="94" y="103" width="42" height="97" rx="5" fill="#8b7964"/></g><path d="M0 545Q500 510 1280 555V720H0" fill="url(#earth)"/><g fill="none" stroke="#a48463" stroke-width="2" opacity=".5"><path d="M0 600Q650 555 1280 610M0 660Q650 620 1280 675"/></g><g transform="translate(385 ${520-rise}) rotate(${pull})"><path d="M-22-60Q-80-170-40-190Q3-163-6-70M8-72Q30-192 75-167Q92-110 20-60" fill="#638b61"/><path d="M-70-60Q0-104 73-60Q124 3 0 80Q-114 3-70-60Z" fill="#eed09b"/><path d="M-38-29Q-15-13-2-28M21-17Q39-12 50-23" fill="none" stroke="#c3a474" stroke-width="3"/><path d="M0 80L-14 99" stroke="#eed09b" stroke-width="7"/></g>${human(510+pull*2,435,'grandpa',t*3)}${k>=2||cover?human(665+pull*2,435,'granny',t*3+.4):''}${k>=3||cover?human(790+pull*2,465,'child',t*3+.7):''}${k>=4||cover?animal(930+pull*2,500,'dog',t*3+.9)+animal(1050+pull*2,515,'cat',t*3+1.2):''}${k>=5||cover?animal(1145+pull,535,'mouse',t*3+1.4):''}<g fill="#e6d6a6" opacity=".8">${[45,170,280,1180].map((x,i)=>`<path d="M${x} 540q-10-36 0-48q14 16 0 48"/>`).join('')}</g><rect x="40" y="34" width="1200" height="72" rx="24" fill="#fff9ed" opacity=".85"/><text x="78" y="81" font-family="Georgia" font-size="34" font-weight="bold" fill="#3e5b50">Репка</text><text x="1198" y="79" text-anchor="end" font-family="sans-serif" font-size="19" letter-spacing="2" fill="#7b8b78">STORY–TALES</text><rect x="128" y="621" width="1024" height="59" rx="24" fill="#fff8e9" opacity=".95"/><text x="640" y="660" text-anchor="middle" font-family="Georgia" font-size="28" fill="#4d6556">${cover?'Сказка для доброго вечера':subtitles[k]}</text></svg>`;
}
const png=svg=>new Resvg(svg,{fitTo:{mode:'width',value:1280},font:{loadSystemFonts:false,fontFiles:['/System/Library/Fonts/Supplemental/Georgia.ttf','/System/Library/Fonts/Supplemental/Arial.ttf'],defaultFontFamily:'Arial'}}).render().asPng();
await writeFile(new URL('cover.png',dir),png(scene(50,true)));
for(let i=0;i<6;i++)await writeFile(new URL(`scene-${i+1}.svg`,dir),scene(cuts[i]+1));
const out=new URL('base.mp4',dir);
const proc=spawn('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','image2pipe','-framerate',String(fps),'-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','24','-pix_fmt','yuv420p','-threads','2','-movflags','+faststart',out.pathname],{stdio:['pipe','inherit','inherit']});
const done=once(proc,'exit');
for(let i=0;i<frames;i++){if(!proc.stdin.write(png(scene(i/fps))))await once(proc.stdin,'drain');}
proc.stdin.end();const [code]=await done;if(code)throw Error(`ffmpeg ${code}`);
const bytes=await readFile(out);const sha=createHash('sha256').update(bytes).digest('hex');
await writeFile(new URL('manifest.json',dir),JSON.stringify({revision:'turnip-v1',catalogId:'turnip-ushinsky-ru-1949-v1',textSha256:'39207ca8c60f88adf5cc9085cf2677fb82dd6da3c7ad41715ea17f7bf3cdaeb7',baseSha256:sha,coverSha256:createHash('sha256').update(await readFile(new URL('cover.png',dir))).digest('hex'),durationSeconds:seconds,fps,width:1280,height:720,audioTracks:0,scenes:cuts.slice(0,6).map((start,i)=>({start,end:cuts[i+1],title:subtitles[i]})),rights:'Own vector artwork, no third-party images, music or voice.'},null,2)+'\n');
await writeFile(new URL('../backend/src/modules/story-gifts/story-video-base.ts',import.meta.url),'/** Versioned silent master. Never replace published bytes under this revision. */\nexport const STORY_VIDEO_BASE = '+await readFile(new URL('manifest.json',dir),'utf8')+' as const;\n');
console.log(JSON.stringify({bytes:bytes.length,sha,seconds,frames}));
