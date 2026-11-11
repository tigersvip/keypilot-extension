import test from 'node:test';
import assert from 'node:assert/strict';
import {removeThinNoise,captchaReviewMasks,softCaptchaViews} from '../src/shared/captchaImage';
import {projectInk,type Mask,type Pixels} from '../src/ocr-lite/digits';

test('thin-line cleanup preserves thick ink and never mutates the original mask',()=>{
  const mask:Mask={width:36,height:18,data:new Uint8Array(36*18)};
  for(let y=4;y<14;y++)for(let x=4;x<32;x++)if(x<13||x>22)mask.data[y*36+x]=1;
  for(let x=1;x<35;x++)mask.data[8*36+x]=1;
  const before=mask.data.slice(),clean=removeThinNoise(mask);
  assert.ok(clean);assert.deepEqual(mask.data,before);
  assert.equal(clean.data[8*36+17],0);assert.equal(clean.data[8*36+8],1);assert.equal(clean.data[8*36+27],1);
  assert.ok(clean.data.reduce((a,b)=>a+b,0)>150);
});

test('cleanup rejects a mask that would erase thin text or tiny punctuation',()=>{
  const mask:Mask={width:32,height:16,data:new Uint8Array(32*16)};
  for(let y=3;y<13;y++)for(const x of [4,12,20,28])mask.data[y*32+x]=1;
  assert.equal(removeThinNoise(mask),undefined);
  assert.equal(removeThinNoise({width:8,height:8,data:new Uint8Array(64)}),undefined);
});

test('ink isolation handles alpha and bounds its alternate views',()=>{
  const width=40,height=24,data=new Uint8ClampedArray(width*height*4);
  for(let y=5;y<19;y++)for(let x=5;x<35;x++)if(x<14||x>25)data.set([70,40,110,255],(y*width+x)*4);
  const original=data.slice(),masks=captchaReviewMasks({width,height,data});
  assert.deepEqual(data,original);assert.ok(masks.length>=1&&masks.length<=2);
  assert.equal(masks[0].data[10*width+8],1);assert.equal(masks[0].data[10*width+20],0);
  assert.equal(masks[0].data[0],0);
  assert.throws(()=>captchaReviewMasks({width,height,data:new Uint8ClampedArray(1)}),/IMAGE_SIZE/);
});

function image(background:number[],ink:number[]):Pixels {
  const width=40,height=24,data=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<width*height;i++)data.set(background,i*4);
  for(let y=5;y<19;y++)for(let x=6;x<34;x++)if(x<14||x>25)data.set(ink,(y*width+x)*4);
  return {width,height,data};
}

test('continuous ink projection preserves antialiasing and normalizes light-on-dark text',()=>{
  for(const [background,ink] of [[[244,248,252,255],[80,40,120,255]],[[30,50,70,255],[250,250,250,255]]]){
    const source=image(background,ink),edge=10*40+14;
    source.data.set(background.map((v,i)=>i===3?255:Math.round((v+ink[i])/2)),edge*4);
    const before=source.data.slice(),out=projectInk(source);
    assert.deepEqual(source.data,before);assert.equal(out.data[0],255);assert.equal(out.data[(10*40+8)*4],0);
    assert.ok(out.data[edge*4]>110&&out.data[edge*4]<145);
    assert.equal(out.data[edge*4],out.data[edge*4+1]);assert.equal(out.data[edge*4+3],255);
  }
});

test('soft views preserve original pixels and remove an isolated thin bridge without erasing thick ink',()=>{
  const source=image([0,0,0,0],[60,30,110,255]);
  for(let x=14;x<26;x++)source.data.set([60,30,110,255],(10*40+x)*4);
  const before=source.data.slice(),[projected,clean]=softCaptchaViews(source);
  assert.deepEqual(source.data,before);assert.equal(projected.data[(10*40+20)*4],0);
  assert.equal(clean.data[(10*40+20)*4],255);assert.equal(clean.data[(10*40+8)*4],0);
  assert.equal(clean.data[0],255);assert.notEqual(projected.data,clean.data);
  assert.ok(projectInk(image([10,20,30,255],[10,20,30,255])).data.every(v=>v===255));
  assert.throws(()=>softCaptchaViews({width:10,height:10,data:new Uint8ClampedArray(1)}),/IMAGE_SIZE/);
});
