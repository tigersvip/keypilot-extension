/** Answers and image parameters are fixed before OCR; no website requests. */
export function arithmeticFixtures(seed:number,count=20){
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  return ['+','-','*','/'].flatMap(operator=>Array.from({length:count},(_,i)=>{
    let a=Math.floor(random()*30),b=Math.floor(random()*19)+1;
    if(operator==='/'){a=(Math.floor(random()*12)+1)*b;}
    const answer=String(operator==='+'?a+b:operator==='-'?a-b:operator==='*'?a*b:a/b);
    const glyph=operator==='*'?(i%3===0?'×':i%3===1?'*':'x'):operator==='/'?(i%2===0?'÷':'/'):operator==='-'&&i%3===0?'−':operator;
    const suffix=i%4===0?'=':'=?',text=`${a}${glyph}${b}${suffix}`,normalized=`${a}${operator}${b}${suffix}`;
    return {operator,text,normalized,answer,font:['Arial','Verdana','Georgia','Tahoma'][Math.floor(random()*4)],bold:random()>.3,
      dark:random()>.85,angle:(random()-.5)*.14,lines:i%4===2,seed:Math.floor(random()*1e6)};
  }));
}
export type ArithmeticFixture=ReturnType<typeof arithmeticFixtures>[number];
export function renderArithmetic(f:ArithmeticFixture):string {
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d')!;
  const font=`${f.bold?'bold':'normal'} 30px "${f.font}"`;ctx.font=font;
  const widths=[...f.text].map(char=>ctx.measureText(char).width);canvas.width=Math.ceil(widths.reduce((a,b)=>a+b,0)+f.text.length*4+28);canvas.height=64;
  const ink=f.dark?'#f6f7f9':'#493566';ctx.fillStyle=f.dark?'#243744':'#f3f8fb';ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.font=font;ctx.fillStyle=ink;ctx.textBaseline='middle';let x=14;
  [...f.text].forEach((char,i)=>{ctx.save();ctx.translate(x+widths[i]/2,32);ctx.rotate(f.angle);ctx.fillText(char,-widths[i]/2,0);ctx.restore();x+=widths[i]+4;});
  if(f.lines){let seed=f.seed;for(let i=0;i<3;i++){
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;const y=8+(seed/2**32)*48;
    ctx.strokeStyle='#8fa5ac';ctx.lineWidth=.8;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(canvas.width,64-y);ctx.stroke();
  }}
  return canvas.toDataURL('image/png');
}
