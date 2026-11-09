const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Execute the actual component's transition functions with controllable media
// elements and timers. Effects/UI are excluded so races are deterministic.
function harness() {
  let source=fs.readFileSync('components/Player.tsx','utf8');
  source=source.replace('  api.current.next = () => advance(1);', '  return {previewSeek, prev, advance, playCurrent, setWantPlay, songsRef, orderRef, posRef, aRef, bRef, activeSlot, shouldPlayRef, seekGrace, playToken};\n  api.current.next = () => advance(1);');
  const exports={};
  const timers=new Map(); let timerId=0;
  const audio={buildOrder: songs=>songs.map(s=>s.id)};
  const context={exports,require:name=>{
    if(name==='react')return {useRef:value=>({current:value}),useState:value=>[value,()=>{}],useEffect:()=>{}};
    if(name==='@/lib/audio')return audio;
    if(name==='@/lib/audioCache')return {};
    return require(name);
  },setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),document:{title:''},navigator:{onLine:true},DOMException,Date};
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(code,context);
  const player=exports.Player({});
  player.songsRef.current=['one','two','three'].map(id=>({id,url:`https://music.test/${id}.mp3`}));
  player.orderRef.current=['one','two','three'];
  player.posRef.current=1;
  player.shouldPlayRef.current=true;
  function media(id) {
    const listeners=new Map();
    let src=`https://music.test/${id}.mp3`;
    return {dataset:{songId:id},readyState:2,duration:200,currentTime:80,seeking:false,ended:false,error:null,paused:false,loads:0,plays:0,
      buffered:{length:1,start:()=>0,end:()=>200},
      get src(){return src;},set src(value){src=value;this.readyState=0;},
      pause(){this.paused=true;},play(){this.plays++;this.paused=false;return Promise.resolve();},
      load(){this.loads++;this.seeking=false;},
      addEventListener(name,fn){listeners.set(name,fn);},removeEventListener(name,fn){if(listeners.get(name)===fn)listeners.delete(name);},
      metadata(){this.readyState=2;listeners.get('loadedmetadata')?.();},listeners};
  }
  player.aRef.current=media('two');player.bRef.current=media('three');
  return {player,timers};
}
test('seek then next cancels queued seek and resets preloaded track position',async()=>{
  const {player:p,timers}=harness();
  p.previewSeek(150);
  const staleCallback=[...timers.values()][0];
  p.advance(1);
  staleCallback(); // even a callback already queued cannot seek the new song
  assert.equal(p.posRef.current,2);
  assert.equal(p.bRef.current.currentTime,0);
  assert.equal(timers.size,0);
  assert.equal(p.seekGrace.current,0);
  assert.equal(p.bRef.current.plays,1);
});
test('seek then previous selects previous track and aborts old media request',()=>{
  const {player:p,timers}=harness();
  p.previewSeek(150);
  [...timers.values()][0]();
  p.aRef.current.seeking=true;
  p.prev();
  assert.equal(p.posRef.current,0);
  assert.equal(p.aRef.current.dataset.songId,'one');
  assert.equal(p.aRef.current.loads,1);
  assert.equal(p.aRef.current.seeking,false);
  assert.equal(p.seekGrace.current,0);
  p.aRef.current.metadata();
  assert.equal(p.aRef.current.plays,1);
});
test('rapid repeated switches remove old metadata listener and ignore its callback',()=>{
  const {player:p}=harness();
  p.bRef.current.readyState=0;
  p.advance(1);
  const stale=p.aRef.current.listeners.get('loadedmetadata');
  p.advance(1);
  const current=p.aRef.current.listeners.get('loadedmetadata');
  assert.notEqual(stale,current);
  stale();
  assert.equal(p.aRef.current.plays,0);
  p.aRef.current.metadata();
  assert.equal(p.aRef.current.plays,1);
  assert.equal(p.aRef.current.dataset.songId,'one');
  assert.equal(p.aRef.current.listeners.size,0);
});
