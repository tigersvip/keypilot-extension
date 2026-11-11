// Select aliases are scoped to the field. Never match arbitrary substrings or
// empty placeholder text: e.g. CA is not both a country and a US state here.
const normalize=(value:string)=>value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g,' ');
const countries=[['us','usa','u.s.a.','united states','united states of america','美国'],['cn','china','中国'],['ca','canada','加拿大'],['gb','uk','united kingdom','英国'],['au','australia','澳大利亚'],['nz','new zealand','新西兰'],['de','germany','德国'],['fr','france','法国'],['jp','japan','日本'],['sg','singapore','新加坡'],['in','india','印度'],['kr','south korea','韩国'],['hk','hong kong','香港'],['tw','taiwan','台湾']];
const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
const chineseMonths=['一','二','三','四','五','六','七','八','九','十','十一','十二'];
const stateAliases: Record<string, string[]> = {
    al: ['al', 'alabama'],
    ak: ['ak', 'alaska'],
    az: ['az', 'arizona'],
    ar: ['ar', 'arkansas'],
    ca: ['ca', 'california'],
    co: ['co', 'colorado'],
    ct: ['ct', 'connecticut'],
    de: ['de', 'delaware'],
    fl: ['fl', 'florida'],
    ga: ['ga', 'georgia'],
    hi: ['hi', 'hawaii'],
    id: ['id', 'idaho'],
    il: ['il', 'illinois'],
    in: ['in', 'indiana'],
    ia: ['ia', 'iowa'],
    ks: ['ks', 'kansas'],
    ky: ['ky', 'kentucky'],
    la: ['la', 'louisiana'],
    me: ['me', 'maine'],
    md: ['md', 'maryland'],
    ma: ['ma', 'massachusetts'],
    mi: ['mi', 'michigan'],
    mn: ['mn', 'minnesota'],
    ms: ['ms', 'mississippi'],
    mo: ['mo', 'missouri'],
    mt: ['mt', 'montana'],
    ne: ['ne', 'nebraska'],
    nv: ['nv', 'nevada'],
    nh: ['nh', 'new hampshire'],
    nj: ['nj', 'new jersey'],
    nm: ['nm', 'new mexico'],
    ny: ['ny', 'new york'],
    nc: ['nc', 'north carolina'],
    nd: ['nd', 'north dakota'],
    oh: ['oh', 'ohio'],
    ok: ['ok', 'oklahoma'],
    or: ['or', 'oregon'],
    pa: ['pa', 'pennsylvania'],
    ri: ['ri', 'rhode island'],
    sc: ['sc', 'south carolina'],
    sd: ['sd', 'south dakota'],
    tn: ['tn', 'tennessee'],
    tx: ['tx', 'texas'],
    ut: ['ut', 'utah'],
    vt: ['vt', 'vermont'],
    va: ['va', 'virginia'],
    wa: ['wa', 'washington'],
    wv: ['wv', 'west virginia'],
    wi: ['wi', 'wisconsin'],
    wy: ['wy', 'wyoming'],
    dc: ['dc', 'district of columbia', 'washington dc']
  };
function aliases(value:string,key:string):string[]{
  const normalized=normalize(value);let extra:string[]=[];
  if(/country$/i.test(key))extra=countries.find(group=>group.includes(normalized))??[];
  else if(/(?:state|province)$/i.test(key))extra=Object.values(stateAliases).find(group=>group.includes(normalized))??[];
  else if(/month$/i.test(key))extra=months.map((month,i)=>[String(i+1),String(i+1).padStart(2,'0'),month,month.slice(0,3),...(i===8?['sept']:[]),`${i+1}月`,chineseMonths[i]+'月']).find(group=>group.includes(normalized))??[];
  else if(/day$/i.test(key)&&/^\d{1,2}$/.test(normalized)&&Number(normalized)>=1&&Number(normalized)<=31)extra=[String(Number(normalized)),normalized.padStart(2,'0')];
  else if(key==='cardExpiryYear'&&/^\d{4}$/.test(normalized))extra=[normalized.slice(-2)];
  return [...new Set([normalized,...extra])].filter(Boolean);
}
export interface FillOption {value:string;text:string;disabled?:boolean}
export function selectFillOption(options:FillOption[],value:string,key:string):number {
  const raw=normalize(value),values=aliases(value,key);if(!raw)return -1;
  const ranked=options.map((option,index)=>{
    if(option.disabled||!option.value.trim())return {index,score:0};
    const label=normalize(option.text),stored=normalize(option.value);
    // Human month labels take precedence over zero-based option values.
    const semanticLabel=values.includes(label)&&/month$/i.test(key);
    const parts=label.split(/\s*[()[\]—–|]\s*/).filter(Boolean);
    const score=semanticLabel?130:label===raw?120:stored===raw?110:values.includes(label)?100:values.includes(stored)?90:parts.some(part=>values.includes(part))?80:0;
    return {index,score};
  }).filter(item=>item.score>0).sort((a,b)=>b.score-a.score);
  return ranked.length&&ranked[0].score!==ranked[1]?.score?ranked[0].index:-1;
}
export interface FillDateParts {year?:string;month?:string;day?:string}
export function parseFillDate(value:string,monthOnly=false):FillDateParts {
  const text=value.trim();let year=0,month=0,day=0;
  const iso=text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  const last=text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  const named=text.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/i)??text.match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/i);
  if(iso){year=+iso[1];month=+iso[2];day=+iso[3];}
  else if(last){const a=+last[1],b=+last[2];if(a<=12&&b<=12&&a!==b)return {};year=+last[3];month=a>12?b:a;day=a>12?a:b;}
  else if(named){const firstIsDay=/^\d+$/.test(named[1]);const name=named[firstIsDay?2:1].toLowerCase();month=months.findIndex(item=>item===name||item.slice(0,3)===name)+1;day=+named[firstIsDay?1:2];year=+named[3];}
  else if(monthOnly){
    const ym=text.match(/^(\d{4})[-/.](\d{1,2})$/),my=text.match(/^(\d{1,2})[-/.](\d{2}|\d{4})$/);
    if(ym){year=+ym[1];month=+ym[2];}else if(my){year=my[2].length===2?2000+Number(my[2]):+my[2];month=+my[1];}
  }
  if((iso||last||named)&&day<1)return {};
  if(year<1000||year>9999||month<1||month>12)return {};
  if(day){const check=new Date(Date.UTC(year,month-1,day));if(check.getUTCFullYear()!==year||check.getUTCMonth()+1!==month||check.getUTCDate()!==day)return {};}
  else if(!monthOnly)return {};
  return {year:String(year),month:String(month),...(day?{day:String(day)}:{})};
}
export function formatFillDate(value:string,type:string,hint='',monthOnly=false):string|undefined {
  const p=parseFillDate(value,monthOnly||type==='month');if(!p.year||!p.month)return;
  const m=p.month.padStart(2,'0'),d=p.day?.padStart(2,'0');
  if(type==='month')return `${p.year}-${m}`;
  if(type==='date')return d?`${p.year}-${m}-${d}`:undefined;
  const pattern=hint.toUpperCase().match(/YYYY[-/.]MM[-/.]DD|DD[-/.]MM[-/.]YYYY|MM[-/.]DD[-/.]YYYY|MM[-/]YYYY|MM[-/]YY/)?.[0];
  if(pattern){if(pattern.includes('DD')&&!d)return;return pattern.replace('YYYY',p.year).replace('YY',p.year.slice(-2)).replace('MM',m).replace('DD',d??'');}
  return value;
}
