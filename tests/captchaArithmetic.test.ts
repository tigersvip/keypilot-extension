import test from 'node:test';
import assert from 'node:assert/strict';
import {parseArithmeticCaptcha,recognizeArithmetic,looksArithmetic,type ArithmeticReading} from '../src/shared/captchaArithmetic';

test('arithmetic parser handles four operators, Unicode, zero, negative and exact decimal answers',()=>{
  for(const [text,answer] of [['８ × ３ ＝ ？','24'],['17+8=?','25'],['4 − 9 =','-5'],['5-5=?','0'],
    ['24÷6=?','4'],['3x7=?','21'],['9*8?','72'],['-12/-8=?','1.5'],['1/8=?','0.125'],['2--3=?','5'],['0003+02=(?)','5']]){
    assert.equal(parseArithmeticCaptcha(text)?.answer,answer,text);
  }
  assert.equal(parseArithmeticCaptcha('3x7')?.ambiguousLetter,true);
  assert.equal(parseArithmeticCaptcha('3+7')?.marked,false);
});

test('arithmetic grammar refuses code, incomplete expressions, invalid division and invented rounding',()=>{
  for(const text of ['alert(1)','2**3=?','1/0=?','1/3=?','2+3=9','2+?=9','a+7?','A7+9','1+2+3=?','1.2+3=?',
    'Infinity+1','10000+1','2+=?','7','1e3+2','__proto__','3;process.exit()','1/128=?'])assert.equal(parseArithmeticCaptcha(text),undefined,text);
  assert.equal(looksArithmetic('12÷3=?'),true);assert.equal(looksArithmetic('A7+9'),false);
});

const text=(value:string,confidence=90):ArithmeticReading=>({text:value,confidence,source:'text'});
const math=(value:string,confidence=98,minimum=96):ArithmeticReading=>({text:value,confidence,minimum,source:'arithmetic'});

test('equations are inferred automatically and answers carry their observed expressions',()=>{
  const result=recognizeArithmetic([text('8×3=?'),math('8*3=?')]);
  assert.equal(result?.arithmetic,true);assert.equal(result?.candidates?.[0].text,'24');assert.equal(result?.candidates?.[0].expression,'8 × 3');
  assert.equal(result?.uncertain,false);
  assert.equal(recognizeArithmetic([text('5-5=?')])?.candidates?.[0].text,'0');
  assert.equal(recognizeArithmetic([text('12+7'),text('12+7',83)])?.candidates?.[0].text,'19');
  assert.equal(recognizeArithmetic([text('12+7')]),undefined);
});

test('restricted readers cannot invent arithmetic intent for ordinary letter or symbol codes',()=>{
  const restricted=[math('7+9=?'),{...text('7+9=?'),source:'focused' as const}];
  assert.equal(recognizeArithmetic([text('A7+9'),...restricted]),undefined);
  assert.equal(recognizeArithmetic(restricted),undefined);
  assert.equal(recognizeArithmetic([text('3x7'),text('3x7')]),undefined);
  assert.equal(recognizeArithmetic([text('3x7')],true)?.candidates?.[0].text,'21');
  assert.equal(recognizeArithmetic([math('7+9=?',Infinity)]),undefined);
});

test('conflicting observed operators keep alternative answers and a review prompt',()=>{
  const result=recognizeArithmetic([text('8+3=?'),text('8-3=?',75),math('8+3=?')]);
  assert.equal(result?.candidates?.[0].text,'11');assert.equal(result?.uncertain,true);
  assert.ok(result?.candidates?.some(candidate=>candidate.text==='5'&&candidate.expression==='8 − 3'));
  assert.equal(recognizeArithmetic([text('8/0=?'),math('8/0=?')]),undefined);
});

test('consistent arithmetic views preserve division when general OCR repeatedly reads a plus',()=>{
  const result=recognizeArithmetic([
    text('24+6=?',95),text('24+6=?',96),text('24+6=?',97),
    {...text('24+6=?',98),source:'focused'},
    math('24/6=?',96,72),math('24/6=?',94,65),
  ]);
  assert.equal(result?.candidates?.[0].text,'4');
  assert.equal(result?.candidates?.[0].expression,'24 ÷ 6');
  assert.equal(result?.uncertain,true);
  assert.ok(result?.candidates?.some(candidate=>candidate.text==='30'));
  // Low-confidence unrestricted text can signal the task, but cannot supply an answer.
  assert.equal(recognizeArithmetic([text('2+6=?',12),math('24/6=?'),math('24/6=?')])?.candidates?.[0].text,'4');
  assert.equal(recognizeArithmetic([text('A7+9',12),math('24/6=?'),math('24/6=?')]),undefined);
});
