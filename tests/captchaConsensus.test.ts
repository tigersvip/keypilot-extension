import test from 'node:test';
import assert from 'node:assert/strict';
import {combineCaptchaReadings,decodeCaptchaSequence,decodeCaptchaAlternatives,chooseNeuralReading,reviewEnhancedCase,reviewSpecialist,reviewSpecialistViews,type TextReading} from '../src/shared/captchaConsensus';
import type {CaptchaResult} from '../src/shared/captcha';

test('CTC decoding preserves zeroes and repeated glyphs separated by blanks',()=>{
  const alphabet=['','0','a','?'];
  const logits=[1,1,0,1,2,2,0,3].flatMap(id=>alphabet.map((_,i)=>i===id?8:-8));
  assert.equal(decodeCaptchaSequence(logits,alphabet).text,'00a?');
  assert.deepEqual(decodeCaptchaSequence(logits,alphabet).characters?.map(char=>char.text),['0','0','a','?']);
  assert.ok(decodeCaptchaSequence(logits,alphabet).characters?.every(char=>char.confidence>99));
  assert.throws(()=>decodeCaptchaSequence([0,NaN,0,1],alphabet),/MODEL_INVALID/);
  assert.throws(()=>decodeCaptchaSequence([1,2],alphabet),/MODEL_INVALID/);
  assert.equal(decodeCaptchaSequence([8,-8,-8,-8],alphabet).text,'');
});

const detailed=(text:string,confidence:number,scores:number[]):TextReading=>({text,confidence,characters:[...text].map((char,i)=>({text:char,confidence:scores[i]}))});

test('character evidence resolves case without letting a word average hide its weak glyph',()=>{
  const result=combineCaptchaReadings(reading('8hvvc'),general(['8hVVC',78],['8hVvC',76]),undefined,undefined,5,
    [detailed('8hVVC',78,[92,93,81,38,84]),detailed('8hVvC',76,[98,98,98,98,96])]);
  assert.equal(result.candidates?.[0].text,'8hVvC');assert.equal(result.uncertain,true);
});

test('corroboration across models protects a stable character from repeated wrong text readings',()=>{
  const neural={...reading('B5r'),characters:detailed('B5r',98,[97,99,98]).characters};
  const result=combineCaptchaReadings(neural,general(['Bor',85],['B5r',88]),undefined,undefined,3,
    [detailed('Bor',85,[98,97,98]),detailed('Bor',84,[98,97,98]),detailed('B5r',88,[90,92,83])]);
  assert.equal(result.candidates?.[0].text,'B5r');assert.equal(result.uncertain,true);
});

test('two clear symbol readings can review a neural shape and retain the original alternative',()=>{
  const result=combineCaptchaReadings(reading('w+Rf9'),general(['w#Rf9',85]),undefined,undefined,5,
    [detailed('w#Rf9',77,[98,97,98,98,95]),detailed('w#Rf9',85,[98,98,98,98,97])]);
  assert.equal(result.candidates?.[0].text,'w#Rf9');assert.ok(result.candidates?.some(item=>item.text==='w+Rf9'));
});

test('a compatible reading is not lost behind the general top-three candidate limit',()=>{
  const result=combineCaptchaReadings(reading('9toq',78,45),general(['9tQ@',86],['9t0@',72],['gto@',72]),undefined,undefined,4,
    [detailed('9to@',52,[93,98,97,95])]);
  assert.equal(result.candidates?.[0].text,'9to@');
});

test('weak case evidence and invalid per-character alignment do not replace a complete result',()=>{
  const initial=general(['gB#gX',76],['gB#gx',47]);
  const result=combineCaptchaReadings(reading('gbgx'),initial,undefined,undefined,5,
    [detailed('gB#gx',47,[98,97,96,98,95]),detailed('gB#gX',76,[49,92,92,86,60])]);
  assert.equal(result.candidates?.[0].text,'gB#gX');
  const invalid=combineCaptchaReadings(reading('2sL'),general(['2sL',90]),undefined,undefined,3,
    [{text:'2SL',confidence:95,characters:[{text:'S',confidence:99}]}]);
  assert.equal(invalid.candidates?.[0].text,'2sL');
});

const reading=(text:string,confidence=98,minimum=95)=>({text,confidence,minimum});
const general=(...items:Array<[string,number]>):CaptchaResult=>({ok:true,engine:'auto',candidates:items.map(([text,confidence])=>({text,confidence})),uncertain:items.length>1});

test('prefix search sums blank/repeat paths and keeps a plausible joined character',()=>{
  const alphabet=['','a','b'];
  const logits=[[-12,12,-12],[.2,-12,0],[-12,12,-12]].flat();
  const alternatives=decodeCaptchaAlternatives(logits,alphabet);
  assert.equal(decodeCaptchaSequence(logits,alphabet).text,'aa');
  assert.ok(alternatives.some(item=>item.text==='aba'&&item.score>.5));
  assert.ok(alternatives.some(item=>item.text==='aa'));
  assert.ok(alternatives.every(item=>Number.isFinite(item.score)&&item.score>=.08&&item.score<=1.00001));
  assert.deepEqual(decodeCaptchaAlternatives([12,-12,-12],alphabet),[]);
  assert.throws(()=>decodeCaptchaAlternatives([NaN,0,0],alphabet),/MODEL_INVALID/);
  const repeated=Array.from({length:11},()=>[[-10000,10000,-10000],[10000,-10000,-10000]]).flat(2);
  assert.deepEqual(decodeCaptchaAlternatives(repeated,alphabet),[]);
});

test('connected-component counts cannot force a touching whole line shorter',()=>{
  assert.equal(combineCaptchaReadings(reading('12345'),general(['1234',90]),undefined,undefined,4).candidates?.[0].text,'12345');
});

test('whole-sequence evidence can corroborate a longer text reading without forcing a fixed length',()=>{
  const neural={...reading('atwpr',88,54),alternatives:[{text:'atwpr',score:1},{text:'atlwpr',score:.3}]};
  assert.equal(combineCaptchaReadings(neural,general(['atiwpr',91],['atlwpr',88])).candidates?.[0].text,'atlwpr');
  assert.notEqual(combineCaptchaReadings({...neural,alternatives:[{text:'atlwpr',score:.01}]},general(['atiwpr',91],['atlwpr',88])).candidates?.[0].text,'atlwpr');
});

test('alternate cleanup cannot promote dropped characters or an isolated confident guess',()=>{
  const original=reading('123',80,50),short=reading('123',99,98),complete=reading('1234',97,94);
  assert.equal(chooseNeuralReading(original,[short],[],undefined,'1234'),original);
  assert.equal(chooseNeuralReading(original,[complete],[],undefined,'123'),original);
  assert.equal(chooseNeuralReading(original,[complete,reading('1234',90,80)],[],undefined,'123'),complete);
  assert.equal(chooseNeuralReading(original,[complete],[],3,'123'),original);
  const stable=reading('ab?d');
  assert.equal(chooseNeuralReading(stable,[reading('abcd',100,100),reading('abcd',100,100)],[],undefined,'ab?d'),stable);
});

test('an observed alternate can use original sequence support without treating it as certainty',()=>{
  const original={...reading('536',91,76),alternatives:[{text:'536',score:1},{text:'5376',score:.9}]},complete=reading('5376',100,99);
  assert.equal(chooseNeuralReading(original,[complete],[],undefined,'53/6'),complete);
});

test('case review uses a complete observed result and exposes disagreement',()=>{
  const result=combineCaptchaReadings(reading('x5q2'),general(['X5Q2',86]));
  assert.equal(result.candidates?.[0].text,'X5Q2');assert.equal(result.uncertain,true);
  assert.equal(result.candidates?.[1].text,'x5q2');
  assert.equal(combineCaptchaReadings(reading('K9pR'),general(['K9pR',92])).uncertain,false);
});

test('retains a complete punctuation candidate when another reading drops a character',()=>{
  const result=combineCaptchaReadings(reading('5-2>',82,48),general(['52?',93],['5-2?',77]));
  assert.equal(result.candidates?.[0].text,'5-2?');assert.equal(result.uncertain,true);
  assert.ok(result.candidates?.some(item=>item.text==='52?'));
  assert.equal(combineCaptchaReadings(reading('012'),general(['012',90]),undefined,4).error,'LENGTH_MISMATCH');
});

test('numeric lookalikes require a complete numeric reading rather than generated replacements',()=>{
  const result=combineCaptchaReadings(reading('7oo4'),general(['7004',92],['7OO4',75]));
  assert.equal(result.candidates?.[0].text,'7004');assert.equal(result.uncertain,true);
  const lone=combineCaptchaReadings(reading('7oo4'),{ok:false,error:'NO_RESULT'});
  assert.deepEqual(lone.candidates?.map(item=>item.text),['7oo4']);assert.equal(lone.uncertain,true);
  assert.equal(combineCaptchaReadings(reading('ukay'),general(['0849',99])).candidates?.[0].text,'ukay');
});

test('weak generic guesses cannot displace a complete rotated-glyph reading',()=>{
  const result=combineCaptchaReadings(reading('7bsh',91,79),general(['A064',52],['eeg',0]));
  assert.equal(result.candidates?.[0].text,'7bsh');assert.equal(result.uncertain,true);
  assert.equal(combineCaptchaReadings(reading('',0,0),{ok:false,error:'NO_RESULT'}).ok,false);
});

test('visible short punctuation keeps a complete observed candidate ahead of a missing-symbol reading',()=>{
  const result=combineCaptchaReadings(reading('3f'),general(['3*f',57]),undefined,undefined,3);
  assert.equal(result.candidates?.[0].text,'3*f');assert.equal(result.uncertain,true);
  const unsupported=combineCaptchaReadings(reading('3f'),general(['3f',90]),undefined,undefined,3);
  assert.ok(!unsupported.candidates?.some(item=>item.text==='3*f'));
});

test('a confident short greedy sequence requires a real path and two aligned readings to extend',()=>{
  const neural={...reading('3281',99,98),alternatives:[{text:'3281',score:1},{text:'32881',score:.09}]};
  const texts=[detailed('32881',92,[98,99,98,97,96]),detailed('32881',91,[97,96,97,97,98])];
  const combine=(n=neural,t=texts,length?:number)=>combineCaptchaReadings(n,general(['32881',92]),undefined,length,undefined,t);
  assert.equal(combine().candidates?.[0].text,'32881');assert.equal(combine().uncertain,true);
  assert.equal(combine({...neural,alternatives:[]}).candidates?.[0].text,'3281');
  assert.equal(combine(neural,texts.slice(0,1)).candidates?.[0].text,'3281');
  assert.equal(combine(neural,[texts[0],detailed('32881',91,[97,89,97,97,98])]).candidates?.[0].text,'3281');
  const invalid={...texts[1],characters:texts[1].characters!.map(char=>({...char,text:'x'}))};
  assert.equal(combine(neural,[texts[0],invalid]).candidates?.[0].text,'3281');
  assert.equal(combine(neural,texts,4).candidates?.[0].text,'3281');
});

test('enhanced full-line case evidence can review a neural match without losing the previous choice',()=>{
  const original=general(['mVpx',75],['mvpx',98]);
  const result=reviewEnhancedCase(original,reading('mvpx'),[detailed('mVpx',75,[95,80,93,92])],
    [detailed('mVPx',88,[96,98,98,97])]);
  assert.equal(result.candidates?.[0].text,'mVPx');assert.equal(result.uncertain,true);
  assert.match(result.reason!,/大小写/);assert.ok(result.candidates?.some(c=>c.text==='mVpx'));
  assert.equal(original.candidates?.[0].text,'mVpx');
});

test('enhanced case review rejects weak, misaligned, nonfinite and different-shape evidence',()=>{
  const original=general(['mvpx',92]);
  for(const enhanced of [detailed('mVPx',88,[96,98,70,97]),detailed('mVPx',40,[98,98,98,98]),
    detailed('mVQx',90,[99,99,99,99]),{...detailed('mVPx',88,[99,99,99,99]),characters:[{text:'m',confidence:99}]},
    detailed('mVPx',Infinity,[99,99,99,99]),detailed('mVPx',88,[99,Infinity,99,99])]){
    assert.equal(reviewEnhancedCase(original,reading('mvpx'),[],[enhanced]),original);
  }
  assert.equal(reviewEnhancedCase(original,reading('mvyx'),[],[detailed('mVPx',95,[99,99,99,99])]),original);
  assert.equal(reviewEnhancedCase(original,reading('mvpx'),[],[detailed('mvpx',95,[99,99,99,99])]),original);
});

test('trained review head may promote a strong complete reading while retaining the original',()=>{
  const original=general(['a7vx',95],['a7yx',70]);
  const result=reviewSpecialist(original,reading('a7Yx',95,88),[]);
  assert.equal(result.candidates?.[0].text,'a7Yx');assert.equal(result.uncertain,true);
  assert.ok(result.candidates?.some(c=>c.text==='a7vx'));assert.equal(original.candidates?.[0].text,'a7vx');
  assert.equal(reviewSpecialist(original,reading('a7Yx',85,65),[]).candidates?.[0].text,'a7vx');
  assert.ok(reviewSpecialist(original,reading('a7Yx',85,65),[]).candidates?.some(c=>c.text==='a7Yx'));
});

test('trained review preserves shorter-repeat, punctuation and strongly supported original shape',()=>{
  const original=general(['41127',95]);
  assert.equal(reviewSpecialist(original,reading('4127',100,99),[]),original);
  assert.equal(reviewSpecialist(original,reading('4ll27',99,98),[detailed('41127',88,[98,98,98,98,98])]).candidates?.[0].text,'41127');
  assert.equal(reviewSpecialist(general(['a+7',80]),reading('at7',100,100),[]).candidates?.[0].text,'a+7');
  assert.equal(reviewSpecialist(original,reading('4ll27',99,98),[],4),original);
  assert.equal(reviewSpecialist(original,reading('4ll27',Infinity,98),[]),original);
  assert.equal(reviewSpecialist(original,reading('4ll27',99,39),[]),original);
  const full=general(['a7vx',95],['a7yx',70],['a7wx',70],['a7tx',70]);
  const reviewed=reviewSpecialist(full,reading('a7yx'),[]);
  assert.equal(reviewed.candidates?.length,4);assert.equal(new Set(reviewed.candidates?.map(c=>c.text)).size,4);
});

test('two complete processed review readings can recover repeated or obscured characters',()=>{
  const original={...reading('827'),refinement:reading('827')};
  const alternates=[{...reading('827'),refinement:reading('8277')},{...reading('8277'),refinement:reading('8277',95,90)}];
  const result=reviewSpecialistViews(general(['827',99]),original,alternates,[]);
  assert.equal(result.candidates?.[0].text,'8277');assert.equal(result.uncertain,true);
  assert.equal(reviewSpecialistViews(general(['827',99]),original,alternates.slice(0,1),[]).candidates?.[0].text,'827');
  assert.equal(reviewSpecialistViews(general(['827',99]),original,alternates,[],3).candidates?.[0].text,'827');
});

test('correlated alternate views cannot shorten or replace a stable complete original',()=>{
  const original={...reading('aBc9'),refinement:reading('aBc9')};
  for(const text of ['abc9','aBc','aBt9']){
    const alternate={...reading(text),refinement:reading(text,100,100)};
    assert.equal(reviewSpecialistViews(general(['aBc9',99]),original,[alternate,alternate],[]).candidates?.[0].text,'aBc9');
  }
});
