/** Experimental, offline digit recognition. No browser, ML runtime, or network dependency. */
export const FEATURE_WIDTH = 20;
export const FEATURE_HEIGHT = 28;
const FEATURE_SIZE = FEATURE_WIDTH * FEATURE_HEIGHT;
export interface Pixels {width:number;height:number;data:Uint8ClampedArray}
export interface Mask {width:number;height:number;data:Uint8Array}
export interface Box {left:number;top:number;right:number;bottom:number;area:number}
export interface Glyph {features:Uint8Array;aspect:number;box:Box}
export interface DigitTemplate {digit:number;aspect:number;features:Uint8Array;norm:number}
export interface DigitResult {
  text:string;alternatives:string[];boxes:Box[];
  state:'review'|'uncertain'|'unreadable'|'length-mismatch';
  reason:string; scores:number[];
}

function contrast(image:Pixels,flatten=false) {
  const {width,height,data}=image;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<8||height<8||width>1800||height>600||data.length!==width*height*4)throw new Error('IMAGE_SIZE');
  const channels:number[][]=[[],[],[]],rgb=new Uint8Array(width*height*3);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const at=y*width+x,alpha=data[at*4+3]/255;
    for(let c=0;c<3;c++){
      const value=Math.round(data[at*4+c]*alpha+255*(1-alpha));rgb[at*3+c]=value;
      if(x<2||y<2||x>=width-2||y>=height-2)channels[c].push(value);
    }
  }
  const background=channels.map(values=>values.sort((a,b)=>a-b)[values.length>>1]);
  // Estimate a smooth background from the image perimeter, without blurring
  // character strokes. Medians tolerate isolated border dots and thin lines.
  const corners=flatten?[[0,0],[width-1,0],[0,height-1],[width-1,height-1]].map(([cx,cy])=>{
    const samples:number[][]=[[],[],[]],rx=Math.max(2,Math.floor(width/8)),ry=Math.max(2,Math.floor(height/8));
    for(let y=Math.max(0,cy-ry);y<=Math.min(height-1,cy+ry);y++)for(let x=Math.max(0,cx-rx);x<=Math.min(width-1,cx+rx);x++){
      if(x>=2&&y>=2&&x<width-2&&y<height-2)continue;
      for(let c=0;c<3;c++)samples[c].push(rgb[(y*width+x)*3+c]);
    }
    return samples.map(values=>values.sort((a,b)=>a-b)[values.length>>1]);
  }):undefined;
  const distances=new Uint8Array(width*height),histogram=new Uint32Array(256),backgrounds=new Uint8Array(rgb.length);
  let sum=0;
  for(let i=0;i<distances.length;i++){
    const x=(i%width)/(width-1),y=Math.floor(i/width)/(height-1);
    let distance=0;
    for(let c=0;c<3;c++){
      const value=corners?(1-y)*((1-x)*corners[0][c]+x*corners[1][c])+y*((1-x)*corners[2][c]+x*corners[3][c]):background[c];
      backgrounds[i*3+c]=Math.round(value);
      distance=Math.max(distance,Math.abs(rgb[i*3+c]-value));
    }
    distance=Math.round(distance);
    distances[i]=distance;histogram[distance]++;sum+=distance;
  }
  let lower=0,weighted=0,best=0,threshold=12;
  for(let t=0;t<255;t++){
    lower+=histogram[t];weighted+=histogram[t]*t;const upper=distances.length-lower;
    if(!lower||!upper)continue;
    const separation=lower*upper*(weighted/lower-(sum-weighted)/upper)**2;
    if(separation>best){best=separation;threshold=t;}
  }
  let tail=0,peak=255;
  while(peak>0){tail+=histogram[peak];if(tail>=distances.length*.015)break;peak--;}
  return {width,height,distances,threshold,peak,rgb,backgrounds};
}
function maskAt(source:ReturnType<typeof contrast>,threshold:number):Mask {
  return {width:source.width,height:source.height,data:source.distances.map(value=>value>Math.max(8,threshold)?1:0)};
}
export function foreground(image:Pixels):Mask {
  const source=contrast(image);
  // Keep antialiased thin strokes; the recognizer also evaluates stricter masks.
  return maskAt(source,Math.round(source.threshold*.6));
}
function inkColor(source:ReturnType<typeof contrast>):number[] {
  const {distances,peak,rgb}=source,channels:number[][]=[[],[],[]];
  const stride=Math.max(1,Math.floor(distances.length/8192));
  for(let i=0;i<distances.length;i+=stride)if(distances[i]>=Math.max(12,peak*.85))for(let c=0;c<3;c++)channels[c].push(rgb[i*3+c]);
  return channels.map(values=>values.sort((a,b)=>a-b)[values.length>>1]??0);
}
function colorMask(source:ReturnType<typeof contrast>):Mask {
  // Infer the main ink colour from high-contrast pixels. Antialiasing lies
  // along the background-to-ink colour vector; differently coloured lines do
  // not. This preserves thin edges instead of simply raising the threshold.
  const {width,height,distances,peak,rgb,backgrounds}=source,ink=inkColor(source),data=new Uint8Array(distances.length);
  for(let i=0;i<distances.length;i++){
    if(distances[i]<=Math.max(8,Math.round(source.threshold*.6)))continue;
    let dot=0,norm=0;
    for(let c=0;c<3;c++){const vector=ink[c]-backgrounds[i*3+c];dot+=(rgb[i*3+c]-backgrounds[i*3+c])*vector;norm+=vector*vector;}
    const alpha=dot/Math.max(1,norm);let residual=0;
    for(let c=0;c<3;c++)residual=Math.max(residual,Math.abs(rgb[i*3+c]-backgrounds[i*3+c]-alpha*(ink[c]-backgrounds[i*3+c])));
    if(alpha>0&&alpha<1.2&&residual<=Math.max(8,peak*.055))data[i]=1;
  }
  return {width,height,data};
}
/** Shared ink isolation for whole-line OCR; this does not assume a digit alphabet. */
export function inkForeground(image:Pixels):Mask {return colorMask(contrast(image,true));}

/** Retain antialiasing instead of erasing every pixel outside the ink colour.
 * The continuous projection also normalizes light text on a dark background. */
export function projectInk(image:Pixels):Pixels {
  const source=contrast(image,true),ink=inkColor(source),{width,height,rgb,backgrounds}=source,data=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<width*height;i++){
    let dot=0,norm=0;
    for(let c=0;c<3;c++){const v=ink[c]-backgrounds[i*3+c];dot+=(rgb[i*3+c]-backgrounds[i*3+c])*v;norm+=v*v;}
    const value=Math.round(255*(1-Math.max(0,Math.min(1,dot/Math.max(1,norm))))),at=i*4;
    data[at]=value;data[at+1]=value;data[at+2]=value;data[at+3]=255;
  }
  return {width,height,data};
}

export function components(mask:Mask):Box[] {
  const {width,height,data}=mask,seen=new Uint8Array(data.length),queue=new Int32Array(data.length),boxes:Box[]=[];
  for(let start=0;start<data.length;start++){
    if(!data[start]||seen[start])continue;
    let length=1;queue[0]=start;seen[start]=1;
    const box:Box={left:width,top:height,right:0,bottom:0,area:0};
    for(let i=0;i<length;i++){
      const at=queue[i],x=at%width,y=Math.floor(at/width);box.left=Math.min(box.left,x);box.right=Math.max(box.right,x);box.top=Math.min(box.top,y);box.bottom=Math.max(box.bottom,y);box.area++;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        const nx=x+dx,ny=y+dy;if(nx<0||nx>=width||ny<0||ny>=height)continue;
        const next=ny*width+nx;if(data[next]&&!seen[next]){seen[next]=1;queue[length++]=next;}
      }
    }
    if(box.area>=3&&box.bottom-box.top>=2)boxes.push(box);
    // Bound fragment merging on large noise-only images.
    if(boxes.length>256)return [];
  }
  // Small serif glyphs can have disconnected upper/lower strokes after
  // rasterisation. Join stacked fragments, but not two full-height neighbours.
  for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){
    const a=boxes[i],b=boxes[j],overlapX=Math.min(a.right,b.right)-Math.max(a.left,b.left)+1;
    const overlapY=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)+1;
    const gapY=Math.max(a.top,b.top)-Math.min(a.bottom,b.bottom)-1;
    if(overlapX>0&&gapY<=Math.max(2,Math.min(a.bottom-a.top+1,b.bottom-b.top+1)*.25)&&overlapY<Math.min(a.bottom-a.top+1,b.bottom-b.top+1)*.3){
      a.left=Math.min(a.left,b.left);a.right=Math.max(a.right,b.right);a.top=Math.min(a.top,b.top);a.bottom=Math.max(a.bottom,b.bottom);a.area+=b.area;boxes.splice(j--,1);
    }
  }
  if(!boxes.length)return [];
  const tallest=Math.max(...boxes.map(box=>box.bottom-box.top+1));
  return boxes.filter(box=>box.bottom-box.top+1>=tallest*.45).sort((a,b)=>a.left-b.left);
}

export function glyph(mask:Mask,box:Box):Glyph {
  // Area sampling keeps thin strokes; do not stretch a one-pixel '1' into a block.
  const w=box.right-box.left+1,h=box.bottom-box.top+1;
  const scale=Math.min((FEATURE_WIDTH-4)/w,(FEATURE_HEIGHT-4)/h),targetW=w*scale,targetH=h*scale;
  const left=(FEATURE_WIDTH-targetW)/2,top=(FEATURE_HEIGHT-targetH)/2;
  const features=new Uint8Array(FEATURE_SIZE);
  for(let y=0;y<FEATURE_HEIGHT;y++)for(let x=0;x<FEATURE_WIDTH;x++){
    let total=0;
    for(let sy=0;sy<4;sy++)for(let sx=0;sx<4;sx++){
      const px=(x+(sx+.5)/4-left)/scale,py=(y+(sy+.5)/4-top)/scale;
      if(px>=0&&py>=0&&px<w&&py<h)total+=mask.data[(box.top+Math.floor(py))*mask.width+box.left+Math.floor(px)];
    }
    features[y*FEATURE_WIDTH+x]=Math.round(total*255/16);
  }
  return {features,aspect:w/h,box};
}

export function encodeTemplates(items:Omit<DigitTemplate,'norm'>[]):Uint8Array {
  const out=new Uint8Array(12+items.length*(FEATURE_SIZE+3)),view=new DataView(out.buffer);
  out.set([75,80,68,49]);view.setUint16(4,FEATURE_WIDTH,true);view.setUint16(6,FEATURE_HEIGHT,true);view.setUint32(8,items.length,true);
  items.forEach((item,i)=>{const at=12+i*(FEATURE_SIZE+3);out[at]=item.digit;view.setUint16(at+1,Math.round(item.aspect*1000),true);out.set(item.features,at+3);});
  return out;
}
export function decodeTemplates(bytes:Uint8Array):DigitTemplate[] {
  if(bytes.length<12)throw new Error('MODEL_INVALID');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),count=view.getUint32(8,true);
  if(bytes[0]!==75||bytes[1]!==80||bytes[2]!==68||bytes[3]!==49||view.getUint16(4,true)!==FEATURE_WIDTH||view.getUint16(6,true)!==FEATURE_HEIGHT||!count||count>10000||bytes.length!==12+count*(FEATURE_SIZE+3))throw new Error('MODEL_INVALID');
  const items:DigitTemplate[]=[];
  for(let i=0;i<count;i++){
    const at=12+i*(FEATURE_SIZE+3),digit=bytes[at],aspect=view.getUint16(at+1,true)/1000,features=bytes.slice(at+3,at+3+FEATURE_SIZE);
    const norm=Math.sqrt(features.reduce((sum,value)=>sum+value*value,0));
    if(digit>9||aspect<=0||aspect>3||!norm)throw new Error('MODEL_INVALID');
    items.push({digit,aspect,features,norm});
  }
  return items;
}
function classify(input:Glyph,templates:DigitTemplate[]){
  const scores=new Float64Array(10).fill(-1),norm=Math.sqrt(input.features.reduce((sum,value)=>sum+value*value,0));
  for(const template of templates){
    let dot=0;for(let i=0;i<FEATURE_SIZE;i++)dot+=input.features[i]*template.features[i];
    const score=dot/(norm*template.norm)-Math.min(.12,Math.abs(Math.log(input.aspect/template.aspect))*.025);
    scores[template.digit]=Math.max(scores[template.digit],score);
  }
  return Array.from(scores,(score,digit)=>({digit:String(digit),score})).sort((a,b)=>b.score-a.score);
}
function readMask(mask:Mask,templates:DigitTemplate[],expectedLength?:number):DigitResult {
  const boxes=components(mask);
  const empty=(state:DigitResult['state'],reason:string):DigitResult=>({text:'',alternatives:[],boxes,state,reason,scores:[]});
  if(boxes.length<2||boxes.length>10)return empty('unreadable','没有找到可可靠分开的数字，请手动输入。');
  if(expectedLength!==undefined&&boxes.length!==expectedLength)return empty('length-mismatch',`分离到 ${boxes.length} 个字符，与指定的 ${expectedLength} 位不一致；不补字或猜位数。`);
  if(boxes.some(box=>(box.right-box.left+1)/(box.bottom-box.top+1)>1.35))return empty('unreadable','字符可能粘连或带有干扰线，暂时无法可靠分开。');
  const ranked=boxes.map(box=>classify(glyph(mask,box),templates));
  const scores=ranked.map(items=>items[0].score);
  if(Math.min(...scores)<.7)return empty('unreadable','字符形状残缺或超出当前数字模板范围，请手动输入。');
  const text=ranked.map(items=>items[0].digit).join('');
  const uncertain=Math.min(...scores)<.78||ranked.some(items=>items[0].score-items[1].score<.025);
  const alternatives=ranked.map((items,i)=>({text:text.slice(0,i)+items[1].digit+text.slice(i+1),gap:items[0].score-items[1].score})).filter(item=>item.gap<.08).sort((a,b)=>a.gap-b.gap).slice(0,2).map(item=>item.text);
  return {text,alternatives,boxes,scores,state:uncertain?'uncertain':'review',reason:uncertain?'存在相似数字或陌生字体，请逐位核对。':'已得到完整候选，请对照原图核对每一位。'};
}

export function recognizeDigits(image:Pixels,templates:DigitTemplate[],expectedLength?:number):DigitResult {
  if(expectedLength!==undefined&&(!Number.isInteger(expectedLength)||expectedLength<2||expectedLength>10))throw new Error('LENGTH_INVALID');
  const original=foreground(image),source=contrast(image,true);
  if(source.peak<12)return {text:'',alternatives:[],boxes:[],scores:[],state:'unreadable',reason:'没有检测到足够清晰的数字，请手动输入。'};
  const masks=[original,colorMask(source),...[source.threshold,source.peak*.45,source.peak*.7,source.peak*.86].map(threshold=>maskAt(source,threshold))];
  const unique=masks.filter((mask,i)=>!masks.slice(0,i).some(other=>mask.data.every((value,j)=>value===other.data[j])));
  const readings=unique.map(mask=>readMask(mask,templates,expectedLength));
  // A strong threshold may erase a thin digit altogether. When the original
  // mask is readable, keep its count instead of rewarding a shorter easy word.
  const valid=readings.filter(result=>result.text&&(!readings[0].text||result.text.length===readings[0].text.length));
  if(!valid.length)return readings[0];
  const quality=(result:DigitResult)=>Math.min(...result.scores)*.6+result.scores.reduce((sum,value)=>sum+value,0)/result.scores.length*.4;
  valid.sort((a,b)=>quality(b)-quality(a));
  const best=valid[0],conflicts=valid.filter(result=>result.text!==best.text&&quality(result)>=quality(best)-.045);
  const rejected=(reason:string):DigitResult=>({...best,text:'',alternatives:[],scores:[],state:'unreadable',reason});
  if(conflicts.some(result=>result.text.length!==best.text.length))return rejected('背景过滤前后的字符数量不一致，可能漏字或断笔，请手动输入。');
  if(!readings[0].text&&valid.filter(result=>result.text===best.text).length<2)return rejected('去除背景后仍未得到稳定的完整结果，请手动输入。');
  if(conflicts.length){
    return {...best,state:'uncertain',alternatives:[...new Set([...conflicts.map(result=>result.text),...best.alternatives])].slice(0,2),reason:'不同背景过滤方式得到的数字不一致，请对照原图逐位核对。'};
  }
  return best;
}
