import alphabet from '../ocr-models/captcha-ascii.json';
import {decodeCaptchaSequence,decodeCaptchaAlternatives} from '../shared/captchaConsensus';
import {ARITHMETIC_ALPHABET} from '../shared/captchaArithmetic';
const reviewAlphabet=alphabet.filter(char=>!char||/^[a-zA-Z0-9]$/.test(char));
type Runtime=typeof import('onnxruntime-web');
let ready:Promise<{ort:Runtime;session:import('onnxruntime-web').InferenceSession}>|undefined;

async function uncompress(url:string){
  const response=await fetch(url);
  if(!response.ok||!response.body)throw new Error('MODEL_MISSING');
  return new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}
function initialize(base:string){
  return ready??=(async()=>{
    const ort:Runtime=await import(/* @vite-ignore */base+'ort.wasm.min.mjs');
    ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;ort.env.wasm.wasmPaths=base;ort.env.logLevel='error';
    const [binary,model]=await Promise.all([uncompress(base+'ort-wasm-simd-threaded.wasm.gz'),uncompress(base+'captcha-ascii.onnx.gz')]);
    ort.env.wasm.wasmBinary=binary;
    const session=await ort.InferenceSession.create(model,{executionProviders:['wasm']});
    ort.env.wasm.wasmBinary=undefined;
    return {ort,session};
  })();
}
self.onmessage=event=>{
  const {id,base,width,pixels,alternatives}=event.data;
  void(async()=>{
    if(!Number.isInteger(width)||width<2||width>9600||!(pixels instanceof Float32Array)||pixels.length!==width*64)throw new Error('IMAGE_INVALID');
    const {ort,session}=await initialize(base);
    const input=new ort.Tensor('float32',pixels,[1,1,64,width]);
    try{
      const output=await session.run({input1:input});
      try{
        const tensor=output['387'],review=output['kp_review'],arithmetic=output['kp_math'];
        if(!tensor||tensor.type!=='float32'||tensor.dims.length!==3||tensor.dims[1]!==1||tensor.dims[2]!==alphabet.length||
          !review||review.type!=='float32'||review.dims.length!==2||review.dims[0]!==tensor.dims[0]||review.dims[1]!==reviewAlphabet.length||
          !arithmetic||arithmetic.type!=='float32'||arithmetic.dims.length!==2||arithmetic.dims[0]!==tensor.dims[0]||arithmetic.dims[1]!==ARITHMETIC_ALPHABET.length)throw new Error('MODEL_INVALID');
        const logits=tensor.data as Float32Array,reading=decodeCaptchaSequence(logits,alphabet);
        reading.refinement=decodeCaptchaSequence(review.data as Float32Array,reviewAlphabet);
        reading.arithmetic=decodeCaptchaSequence(arithmetic.data as Float32Array,ARITHMETIC_ALPHABET);
        if(alternatives&&reading.text.length>=2&&reading.text.length<=10)reading.alternatives=decodeCaptchaAlternatives(logits,alphabet);
        self.postMessage({id,ok:true,reading});
      }finally{for(const tensor of Object.values(output))tensor.dispose();}
    }finally{input.dispose();}
  })().catch(()=>self.postMessage({id,ok:false,error:'OCR_FAILED'}));
};
