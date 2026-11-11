import {inkForeground,projectInk,type Mask,type Pixels} from '../ocr-lite/digits';

/** A small median on a continuous ink image removes thin lines without first
 * cutting holes at coloured intersections. Original pixels remain untouched. */
export function softCaptchaViews(image:Pixels):Pixels[] {
  const projected=projectInk(image),{width,height}=projected,data=projected.data.slice(),values:number[]=[];
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    values.length=0;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)values.push(projected.data[((y+dy)*width+x+dx)*4]);
    values.sort((a,b)=>a-b);const at=(y*width+x)*4;data[at]=values[4];data[at+1]=values[4];data[at+2]=values[4];
  }
  return [projected,{width,height,data}];
}

/** Remove narrow connections in an alternate mask, never in the original image.
 * A cross-shaped opening preserves diagonal joins better than a square kernel. */
export function removeThinNoise(mask:Mask):Mask|undefined {
  const {width,height,data}=mask,core=new Uint8Array(data.length),clean=new Uint8Array(data.length);
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    const i=y*width+x;core[i]=data[i]&data[i-1]&data[i+1]&data[i-width]&data[i+width];
  }
  let before=0,after=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=y*width+x;before+=data[i];
    clean[i]=data[i]&&(core[i]||(x>0&&core[i-1])||(x<width-1&&core[i+1])||(y>0&&core[i-width])||(y<height-1&&core[i+width]))?1:0;after+=clean[i];
  }
  // Thin fonts and tiny punctuation can disappear. Reject destructive masks;
  // the surviving alternate still needs corroboration before it can rank first.
  return after>=20&&after>=before*.55&&after<before*.98?{width,height,data:clean}:undefined;
}

export function captchaReviewMasks(image:Pixels):Mask[] {
  const ink=inkForeground(image),clean=removeThinNoise(ink);
  return [ink,clean].filter((mask):mask is Mask=>Boolean(mask));
}
