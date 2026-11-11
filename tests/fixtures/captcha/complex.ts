/** Synthetic labels are chosen before rendering. Never use a live CAPTCHA endpoint. */
export function complexFixtures(seed:number,count=20){
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  return ['clean','touching','overlap','warp','lines','mixed'].flatMap(kind=>Array.from({length:count},(_,i)=>{
    const alphabet=i%3===0?'0123456789':i%3===1?'abcdefghijklmnopqrstuvwxyz':'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const text=Array.from({length:4+Math.floor(random()*3)},()=>alphabet[Math.floor(random()*alphabet.length)]).join('');
    return {kind,text,font:['Arial','Verdana','Georgia','Tahoma'][Math.floor(random()*4)],bold:random()>.25,dark:random()>.85,
      angles:[...text].map(()=>random()*.5-.25),phase:random()*Math.PI*2,lineSeed:Math.floor(random()*1e6)};
  }));
}
export type ComplexFixture=ReturnType<typeof complexFixtures>[number];
export function renderComplex(f:ComplexFixture):string {
  const image=document.createElement('canvas'),ctx=image.getContext('2d')!;
  const font=`${f.bold?'bold':'normal'} 34px "${f.font}"`;
  ctx.font=font;const widths=[...f.text].map(char=>ctx.measureText(char).width);
  const gap=f.kind==='touching'?-2:f.kind==='overlap'||f.kind==='mixed'?-6:7;
  image.width=Math.ceil(widths.reduce((sum,w)=>sum+w+gap,0))+40;image.height=72;
  const background=f.dark?'#253442':'#f1f7fa',ink=f.dark?'#fff':'#453666';
  ctx.fillStyle=background;ctx.fillRect(0,0,image.width,image.height);ctx.font=font;ctx.textBaseline='middle';ctx.fillStyle=ink;
  let at=20;[...f.text].forEach((char,i)=>{
    ctx.save();ctx.translate(at+widths[i]/2,36);ctx.rotate(f.kind==='clean'?0:f.angles[i]);ctx.fillText(char,-widths[i]/2,0);ctx.restore();at+=widths[i]+gap;
  });
  if(f.kind==='warp'||f.kind==='mixed'){
    const pixels=ctx.getImageData(0,0,image.width,image.height),output=ctx.createImageData(image.width,image.height);
    for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++){
      const sy=Math.round(y+7*Math.sin(x/image.width*Math.PI*3+f.phase)),sx=Math.round(x+3*Math.sin(y/72*Math.PI*2));
      const to=(y*image.width+x)*4,from=(sy*image.width+sx)*4;
      if(sx>=0&&sx<image.width&&sy>=0&&sy<image.height)output.data.set(pixels.data.subarray(from,from+4),to);
      else {const color=f.dark?[37,52,66]:[241,247,250];output.data.set([...color,255],to);}
    }
    ctx.putImageData(output,0,0);
  }
  if(f.kind==='lines'||f.kind==='mixed'){
    let seed=f.lineSeed;
    for(let i=0;i<10;i++){
      const values:number[]=[];for(let k=0;k<5;k++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;values.push(seed/2**32);}
      ctx.strokeStyle=i%3===0?ink:f.dark?'#719495':'#a87367';ctx.lineWidth=.8+values[0]*.6;
      const y=8+values[1]*56;ctx.beginPath();ctx.moveTo(0,y);ctx.bezierCurveTo(image.width*.3,y+values[2]*30-15,image.width*.7,y+values[3]*30-15,image.width,8+values[4]*56);ctx.stroke();
    }
  }
  return image.toDataURL('image/png');
}
