/* Amble Beats sound engine — sampled Steinway grand piano with a soft glockenspiel sparkle,
   a real drum kit, and a small room reverb + gentle compressor on the master.
   Samples: audio/amble-samples.js (VCSL, CC0). Loaded after the page loads; until they are
   decoded AmbleSound.note()/drum() return false and the page plays its built-in synth instead.
   Optional dest: an AudioNode to play into (e.g. the page's master gain); defaults to ctx.destination. */
(function(){
'use strict';
var SAMPLES_SRC=(function(){var s=document.currentScript;try{return new URL('audio/amble-samples.js',s&&s.src?s.src:location.href).href}catch(e){return 'audio/amble-samples.js'}})();
var st=function(n){return Math.pow(2,n/12)};
/* note -> [piano sample, semitone shift, glockenspiel sample (sounds 2 octaves up), shift, stereo pan] */
var NOTES={
  C4:['piano-C4',0,'glock-C5',0,-.36], D4:['piano-D4',0,'glock-C5',2,-.26],
  E4:['piano-E4',0,'glock-G5',-3,-.16],F4:['piano-Fs4',-1,'glock-G5',-2,-.06],
  G4:['piano-Gs4',-1,'glock-G5',0,.06], A4:['piano-As4',-1,'glock-G5',2,.16],
  B4:['piano-C5',-1,'glock-C6',-1,.26], C5:['piano-C5',0,'glock-C6',0,.36]
};
/* drum -> [gain, reverb send, pan] */
var DRUMS={kick:[.95,.05,0],snare:[1.1,.16,-.08],hihat:[.75,.08,.22],tom1:[1.15,.14,-.18],tom2:[1.15,.14,.18],clap:[1,.2,.05],crash:[.7,.22,.28],shaker:[.8,.1,-.25]};
var buffers={},loading=false,chains=[];

function load(){
  if(loading)return;loading=true;
  var s=document.createElement('script');s.src=SAMPLES_SRC;s.async=true;s.onload=decodeAll;
  (document.head||document.documentElement).appendChild(s);
}
function decodeAll(){
  var data=window.AMBLE_SAMPLES,OAC=window.OfflineAudioContext||window.webkitOfflineAudioContext;
  if(!data||!OAC)return;
  var oac;try{oac=new OAC(1,44100,44100)}catch(e){return}
  Object.keys(data).forEach(function(k){
    var bin=atob(data[k]),bytes=new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
    try{
      var p=oac.decodeAudioData(bytes.buffer,function(b){store(k,b)},function(){});
      if(p&&p.catch)p.catch(function(){});
    }catch(e){}
  });
  try{delete window.AMBLE_SAMPLES}catch(e){window.AMBLE_SAMPLES=undefined}
}
/* MP3 decoders may add a few ms of encoder padding; start each sample at its real attack */
function store(k,b){
  var d=b.getChannelData(0),peak=0,i;
  for(i=0;i<d.length;i++){var v=Math.abs(d[i]);if(v>peak)peak=v}
  for(i=0;i<d.length&&Math.abs(d[i])<peak*.02;i++){}
  buffers[k]={buf:b,start:Math.max(0,i/b.sampleRate-.002)};
}
function impulse(ctx,sec){
  var rate=ctx.sampleRate,len=Math.floor(rate*sec),b=ctx.createBuffer(2,len,rate),pre=Math.floor(rate*.012);
  for(var c=0;c<2;c++){var d=b.getChannelData(c);for(var i=0;i<len;i++){d[i]=(Math.random()*2-1)*Math.pow(1-i/len,3.4)*(i<pre?i/pre:1)}}
  return b;
}
function chain(ctx,dest){
  dest=dest||ctx.destination;
  for(var i=0;i<chains.length;i++)if(chains[i].ctx===ctx&&chains[i].dest===dest)return chains[i];
  var comp=ctx.createDynamicsCompressor();
  comp.threshold.value=-16;comp.knee.value=14;comp.ratio.value=3;comp.attack.value=.004;comp.release.value=.22;
  var master=ctx.createGain();master.gain.value=.95;
  master.connect(comp);comp.connect(dest);
  var verbIn=ctx.createGain(),hp=ctx.createBiquadFilter(),verb=ctx.createConvolver(),lp=ctx.createBiquadFilter(),verbOut=ctx.createGain();
  hp.type='highpass';hp.frequency.value=240;lp.type='lowpass';lp.frequency.value=7000;
  verb.buffer=impulse(ctx,2.1);verbOut.gain.value=.55;
  verbIn.connect(hp);hp.connect(verb);verb.connect(lp);lp.connect(verbOut);verbOut.connect(master);
  var ch={ctx:ctx,dest:dest,master:master,verbIn:verbIn};chains.push(ch);return ch;
}
function play(ctx,key,gain,rate,pan,rev,dest){
  var s=buffers[key];if(!s)return false;
  var ch=chain(ctx,dest),now=ctx.currentTime;
  var src=ctx.createBufferSource(),g=ctx.createGain(),out=g;
  src.buffer=s.buf;src.playbackRate.value=rate;g.gain.value=gain;
  src.connect(g);
  if(pan&&ctx.createStereoPanner){var p=ctx.createStereoPanner();p.pan.value=pan;g.connect(p);out=p}
  out.connect(ch.master);
  if(rev){var r=ctx.createGain();r.gain.value=rev;out.connect(r);r.connect(ch.verbIn)}
  src.start(now,s.start);
  src.onended=function(){try{out.disconnect()}catch(e){}};
  return true;
}
function usable(ctx){return !!ctx&&ctx.state==='running'}

window.AmbleSound={
  /* name: 'C4'..'C5'; vol: optional 0..1; dest: optional AudioNode. Returns true when the sampled sound played. */
  note:function(ctx,name,vol,dest){
    var n=NOTES[name];if(!usable(ctx)||!n)return false;
    var v=(.88+Math.random()*.12)*(vol==null?1:vol);
    if(!play(ctx,n[0],.95*v,st(n[1]),n[4],.3,dest))return false;
    play(ctx,n[2],.16*v,st(n[3]),n[4]*1.4,.45,dest);
    return true;
  },
  /* type: kick | snare | hihat | tom1 | tom2 | clap | crash | shaker; vol: optional 0..1; dest: optional AudioNode */
  drum:function(ctx,type,vol,dest){
    var d=DRUMS[type];if(!usable(ctx)||!d)return false;
    return play(ctx,type,d[0]*(.9+Math.random()*.1)*(vol==null?1:vol),1,d[2],d[1],dest);
  },
  ready:function(){return !!buffers['piano-C4']}
};

if(document.readyState==='complete')setTimeout(load,0);else window.addEventListener('load',function(){setTimeout(load,150)});
['pointerdown','touchstart','keydown'].forEach(function(t){window.addEventListener(t,load,{passive:true,once:true})});
})();
