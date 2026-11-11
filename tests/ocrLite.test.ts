import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {foreground,components,decodeTemplates,recognizeDigits,type Pixels} from '../src/ocr-lite/digits';
const model=()=>new Uint8Array(gunzipSync(readFileSync(new URL('../src/ocr-lite/digits-v1.bin.gz',import.meta.url))));
const templates=decodeTemplates(model());
function strokes(count:number,transparent=false):Pixels {
 const width=80,height=32,data=new Uint8ClampedArray(width*height*4);
 if(!transparent)data.fill(255);
 for(let i=0;i<count;i++)for(let y=6;y<26;y++){const at=(y*width+8+i*15)*4;data[at]=30;data[at+1]=15;data[at+2]=100;data[at+3]=255;}
 return {width,height,data};
}
test('thin, separated digits are not discarded on white or transparent backgrounds',()=>{
 for(const transparent of [false,true]){const boxes=components(foreground(strokes(4,transparent)));assert.equal(boxes.length,4);assert.ok(boxes.every(box=>box.right===box.left&&box.bottom-box.top===19));}
});
test('expected length rejects an incomplete reading without padding or inventing a digit',()=>{
 const result=recognizeDigits(strokes(3),templates,4);assert.equal(result.state,'length-mismatch');assert.equal(result.text,'');assert.equal(result.alternatives.length,0);
});
test('blank images, invalid dimensions and corrupt models fail explicitly',()=>{
 assert.equal(recognizeDigits(strokes(0),templates).state,'unreadable');
 assert.throws(()=>foreground({...strokes(4),width:Infinity}),/IMAGE_SIZE/);
 assert.throws(()=>foreground({...strokes(4),data:new Uint8ClampedArray(4)}),/IMAGE_SIZE/);
 assert.throws(()=>recognizeDigits(strokes(4),templates,4.5),/LENGTH_INVALID/);
 assert.throws(()=>decodeTemplates(new Uint8Array([75,80,68,49])),/MODEL_INVALID/);
 const bytes=model();bytes[12]=11;
 assert.throws(()=>decodeTemplates(bytes),/MODEL_INVALID/);
});

function backgroundDigits(text:string,kind:'plain'|'gradient'|'grid'|'dots'):Pixels {
 const width=160,height=44,data=new Uint8ClampedArray(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const at=(y*width+x)*4,shade=kind==='gradient'?245-Math.round(x/width*55):245;
  const noisy=(kind==='grid'&&(y%9===0||x%17===0))||(kind==='dots'&&(x*11+y*7)%91===0);
  data[at]=noisy?170:shade;data[at+1]=noisy?185:shade+5;data[at+2]=noisy?195:shade+8;data[at+3]=255;
 }
 [...text].forEach((digit,i)=>{
  const features=templates[20+Number(digit)].features;
  for(let y=0;y<28;y++)for(let x=0;x<20;x++){
   const at=((y+8)*width+x+12+i*32)*4,alpha=features[y*20+x]/255;
   for(let c=0;c<3;c++)data[at+c]=Math.round(data[at+c]*(1-alpha)+[75,45,115][c]*alpha);
  }
 });
 return {width,height,data};
}
test('background filtering retains complete digits and leading zeros',()=>{
 // Fixed template rasters exercise preprocessing, not a font accuracy claim.
 for(const kind of ['plain','gradient','grid','dots'] as const){
  const result=recognizeDigits(backgroundDigits('0018',kind),templates,4);
  assert.equal(result.text,'0018',kind);
  assert.equal(recognizeDigits(backgroundDigits('018',kind),templates,4).text,'',kind+' missing digit');
 }
});
test('backgrounds without characters do not produce a digit candidate',()=>{
 for(const kind of ['plain','gradient','grid','dots'] as const){
  const result=recognizeDigits(backgroundDigits('',kind),templates);
  assert.equal(result.text,'',kind);assert.deepEqual(result.alternatives,[]);
 }
});
test('distant speckles do not join a glyph and excessive components are bounded',()=>{
 const width=80,height=60,data=new Uint8Array(width*height);
 for(let y=30;y<50;y++)data[y*width+20]=1;
 for(let y=2;y<5;y++)data[y*width+20]=1;
 assert.deepEqual(components({width,height,data}),[{left:20,top:30,right:20,bottom:49,area:20}]);
 const noisy={width:120,height:120,data:new Uint8Array(14400)};
 for(let y=1;y<118;y+=6)for(let x=1;x<118;x+=6)for(let dy=0;dy<3;dy++)noisy.data[(y+dy)*120+x]=1;
 assert.deepEqual(components(noisy),[]);
});
