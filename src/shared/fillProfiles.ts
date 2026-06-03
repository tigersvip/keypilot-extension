import { unzipSync } from 'fflate';
import type { FillField, FillFieldGroup, FillFieldSensitivity, FillProfile, FillProfileCategory } from './types';

export interface FillProfileImportPreview {
  sourceName: string;
  sourceType: 'xlsx' | 'csv' | 'kpfill';
  totalRows: number;
  importableRows: number;
  fieldCount: number;
  countryCode: string;
  category: FillProfileCategory;
  sensitiveFieldCount: number;
  emptyFieldCount: number;
  headers: FillHeaderMapping[];
  profiles: FillProfile[];
  sampleProfiles: FillProfile[];
}

export interface FillHeaderMapping {
  column: string;
  key: string;
  label: string;
  group: FillFieldGroup;
  sensitivity: FillFieldSensitivity;
  aliases: string[];
}

interface KpFillExport {
  format: 'keypilot-fill-profiles';
  version: 1;
  exportedAt: string;
  profiles: FillProfile[];
}

interface ParsedSheet {
  name: string;
  rows: string[][];
}

interface HeaderRule {
  key: string;
  label: string;
  group: FillFieldGroup;
  sensitivity?: FillFieldSensitivity;
  aliases: string[];
}

const ROOT_FOLDER = '车险资料';
const LOAN_FOLDER = '贷款资料';
const BUSINESS_FOLDER = '公司资料';
const XML_TYPE = 'application/xml';
const DEFAULT_COUNTRY = 'US';

const HEADER_RULES: Array<[RegExp, HeaderRule]> = [
  [/^(middle\s*name|middlename|mname|mi|middle\s*initial)$/i, rule('middleName', 'Middle name', 'personal', ['middle name', 'middle initial'])],
  [/^(applicant\s*name|contact\s*name|customer\s*name|lead\s*name|borrower\s*name|insured\s*name)$/i, rule('fullName', 'Full name', 'personal', ['applicant name', 'contact name', 'customer name', 'borrower name', 'insured name'])],
  [/^(home\s*phone|personal\s*phone|primary\s*phone)$/i, rule('phone', 'Phone', 'contact', ['home phone', 'personal phone', 'primary phone'])],
  [/^(work\s*phone|office\s*phone)$/i, rule('businessPhone', 'Business phone', 'business', ['work phone', 'office phone', 'business phone'])],
  [/^(mailing\s*address|residential\s*address|home\s*address|current\s*address)$/i, rule('address1', 'Address', 'address', ['mailing address', 'residential address', 'home address', 'current address'])],
  [/^(merchant\s*name|vendor\s*name|seller\s*name|agency\s*name|affiliate\s*company|business\s*legal\s*name|company\s*legal\s*name)$/i, rule('businessName', 'Business name', 'business', ['merchant name', 'vendor name', 'seller name', 'agency name', 'business legal name'])],
  [/^(business\s*tax\s*id|company\s*tax\s*id|irs\s*tax\s*id|federal\s*employer\s*id|employer\s*id\s*number)$/i, rule('ein', 'EIN', 'business', ['business tax id', 'company tax id', 'irs tax id', 'federal employer id'], 'secret')],
  [/^(average\s*monthly\s*deposits|monthly\s*bank\s*deposits|monthly\s*gross\s*sales)$/i, rule('monthlyRevenue', 'Monthly revenue', 'finance', ['average monthly deposits', 'monthly bank deposits', 'monthly gross sales'])],
  [/^(annual\s*gross\s*receipts|gross\s*yearly\s*sales|gross\s*annual\s*sales)$/i, rule('annualRevenue', 'Annual revenue', 'finance', ['annual gross receipts', 'gross yearly sales', 'gross annual sales'])],
  [/^(requested\s*capital|requested\s*funding\s*amount|cash\s*advance\s*amount|advance\s*amount|capital\s*requested)$/i, rule('loanAmount', 'Loan amount', 'loan', ['requested capital', 'requested funding amount', 'cash advance amount', 'advance amount'])],
  [/^(use\s*of\s*proceeds|intended\s*use|funds\s*purpose|reason\s*for\s*loan)$/i, rule('loanPurpose', 'Loan purpose', 'loan', ['use of proceeds', 'intended use', 'funds purpose'])],
  [/^(deposit\s*account\s*number|dda\s*account|checking\s*account\s*number)$/i, rule('bankAccountNumber', 'Bank account number', 'finance', ['deposit account number', 'dda account', 'checking account number'], 'secret')],
  [/^(first\s*name|firstname|fname|given[-_\s]*name|名)$/i, rule('firstName', '名', 'personal', ['first name', 'firstname', 'fname', 'given name', '名'])],
  [/^(last\s*name|lastname|lname|family[-_\s]*name|surname|姓)$/i, rule('lastName', '姓', 'personal', ['last name', 'lastname', 'lname', 'family name', 'surname', '姓'])],
  [/^(full\s*name|fullname|name|姓名)$/i, rule('fullName', '姓名', 'personal', ['full name', 'fullname', 'name', '姓名', '联系人'])],
  [/^(dob|date\s*of\s*birth|birth\s*date|birthday|出生|生日)$/i, rule('dob', '出生日期', 'personal', ['dob', 'date of birth', 'birthdate', 'birthday', '出生日期', '生日'], 'private')],
  [/^(gender|sex|性别)$/i, rule('gender', '性别', 'personal', ['gender', 'sex', '性别'])],
  [/^(marital\s*status|marital|婚姻|婚姻状况)$/i, rule('maritalStatus', '婚姻状况', 'personal', ['marital status', 'marital', '婚姻状况'])],
  [/^(education|学历|教育)$/i, rule('education', '教育程度', 'personal', ['education', '学历', '教育'])],
  [/^(occupation|job|profession|职业|工作)$/i, rule('occupation', '职业', 'personal', ['occupation', 'job', 'profession', '职业'])],
  [/^(phone1|phone|mobile|tel|telephone|手机|电话)$/i, rule('phone', '电话', 'contact', ['phone', 'mobile', 'tel', 'telephone', '手机', '电话'])],
  [/^(email1|email|mail|e-mail|邮箱|电子邮件)$/i, rule('email', '邮箱', 'contact', ['email', 'mail', 'e-mail', '邮箱', '电子邮件'])],
  [/^(ip|ip\s*address)$/i, rule('ipAddress', 'IP', 'contact', ['ip', 'ip address'])],
  [/^(website|web\s*site|url|company\s*website|business\s*website|网站|公司网站)$/i, rule('website', '网站', 'contact', ['website', 'url', 'company website', 'business website', '网站'])],
  [/^(address1|address\s*1|street|street\s*address|addr1|地址1|地址)$/i, rule('address1', '地址1', 'address', ['address', 'address1', 'street', 'street address', '地址'])],
  [/^(address2|address\s*2|apt|suite|unit|addr2|地址2)$/i, rule('address2', '地址2', 'address', ['address2', 'apt', 'suite', 'unit', '地址2'])],
  [/^(city|town|城市|市)$/i, rule('city', '城市', 'address', ['city', 'town', '城市', '市'])],
  [/^(state|province|region|州|省)$/i, rule('state', '州/省', 'address', ['state', 'province', 'region', '州', '省'])],
  [/^(zip|zipcode|zip\s*code|postal|postal\s*code|postcode|邮编)$/i, rule('postalCode', '邮编', 'address', ['zip', 'zip code', 'postal code', 'postcode', '邮编'])],
  [/^(country|country\s*code|country\s*\/\s*region|country\s*region|nation|nationality|国家|国家\/地区|所在国家|地区国家)$/i, rule('country', '国家', 'address', ['country', 'country code', 'country/region', 'country region', 'nation', 'nationality', '国家', '国家/地区', '所在国家'])],
  [/^(ssn|social\s*security|social\s*security\s*number|身份证|证件号)$/i, rule('ssn', 'SSN', 'sensitive', ['ssn', 'social security', 'social security number', '身份证', '证件号'], 'secret')],
  [/^(card|card\s*number|cc|credit\s*card|信用卡|卡号)$/i, rule('cardNumber', '卡号', 'payment', ['card number', 'credit card', 'cc', '信用卡', '卡号'], 'secret')],
  [/^(cvv|cvc|security\s*code|card\s*code|安全码)$/i, rule('cvv', 'CVV', 'payment', ['cvv', 'cvc', 'security code', '安全码'], 'secret')],
  [/^(expiration|expiry|exp|card\s*expiry|有效期)$/i, rule('cardExpiry', '卡有效期', 'payment', ['expiry', 'expiration', 'exp', '有效期'], 'secret')],
  [/^(company|company\s*name|business|business\s*name|legal\s*business\s*name|legal\s*name|organization|organisation|公司|公司名称|企业名称)$/i, rule('businessName', '公司名称', 'business', ['company', 'company name', 'business name', 'legal business name', 'organization', '公司名称'])],
  [/^(dba|doing\s*business\s*as|trade\s*name|assumed\s*name|品牌名|经营名称)$/i, rule('dbaName', 'DBA/经营名称', 'business', ['dba', 'doing business as', 'trade name', 'assumed name'])],
  [/^(entity|entity\s*type|business\s*type|company\s*type|legal\s*structure|公司类型|企业类型)$/i, rule('entityType', '企业类型', 'business', ['entity type', 'business type', 'company type', 'legal structure'])],
  [/^(ein|fein|federal\s*tax\s*id|tax\s*id|taxpayer\s*id|irs\s*number|联邦税号|税号)$/i, rule('ein', 'EIN/税号', 'business', ['ein', 'fein', 'federal tax id', 'tax id', 'employer identification number', '税号'], 'secret')],
  [/^(business\s*phone|company\s*phone|office\s*phone|公司电话|企业电话)$/i, rule('businessPhone', '公司电话', 'business', ['business phone', 'company phone', 'office phone', '公司电话'])],
  [/^(business\s*email|company\s*email|work\s*email|公司邮箱|企业邮箱)$/i, rule('businessEmail', '公司邮箱', 'business', ['business email', 'company email', 'work email', '公司邮箱'])],
  [/^(business\s*address1|business\s*address\s*1|company\s*address1|company\s*address\s*1|business\s*street|company\s*street|公司地址|企业地址)$/i, rule('businessAddress1', '公司地址1', 'business', ['business address', 'company address', 'business street', 'company street', '公司地址'])],
  [/^(business\s*address2|business\s*address\s*2|company\s*address2|company\s*address\s*2|business\s*suite|company\s*suite|公司地址2)$/i, rule('businessAddress2', '公司地址2', 'business', ['business address line 2', 'company suite', 'suite', 'unit'])],
  [/^(business\s*city|company\s*city|公司城市)$/i, rule('businessCity', '公司城市', 'business', ['business city', 'company city', 'city'])],
  [/^(business\s*state|company\s*state|state\s*of\s*business|公司州|公司省)$/i, rule('businessState', '公司州/省', 'business', ['business state', 'company state', 'state'])],
  [/^(business\s*zip|business\s*zipcode|business\s*postal|company\s*zip|company\s*postal|公司邮编)$/i, rule('businessPostalCode', '公司邮编', 'business', ['business zip', 'company zip', 'postal code'])],
  [/^(business\s*country|company\s*country|country\s*of\s*business|company\s*country\s*\/\s*region|公司国家|企业国家|公司国家\/地区)$/i, rule('businessCountry', '公司国家', 'business', ['business country', 'company country', 'country of business', 'country', '公司国家', '企业国家'])],
  [/^(industry|business\s*industry|sector|行业)$/i, rule('industry', '行业', 'business', ['industry', 'business industry', 'sector', '行业'])],
  [/^(naics|naics\s*code|sic|sic\s*code|行业代码)$/i, rule('industryCode', '行业代码', 'business', ['naics', 'naics code', 'sic', 'sic code'])],
  [/^(business\s*start\s*date|start\s*date|date\s*established|established|founded|incorporation\s*date|成立日期|开业日期)$/i, rule('businessStartDate', '成立日期', 'business', ['business start date', 'date established', 'founded', 'incorporation date'])],
  [/^(state\s*of\s*incorporation|incorporation\s*state|formed\s*in|注册州|成立州)$/i, rule('stateOfIncorporation', '注册州', 'business', ['state of incorporation', 'incorporation state', 'formed in'])],
  [/^(employees|number\s*of\s*employees|employee\s*count|员工数|雇员数)$/i, rule('employeeCount', '员工数', 'business', ['employees', 'number of employees', 'employee count'])],
  [/^(annual\s*revenue|gross\s*annual\s*revenue|yearly\s*revenue|sales|annual\s*sales|年收入|年营业额)$/i, rule('annualRevenue', '年营业额', 'finance', ['annual revenue', 'gross annual revenue', 'yearly revenue', 'annual sales'])],
  [/^(monthly\s*revenue|average\s*monthly\s*revenue|monthly\s*sales|月收入|月营业额)$/i, rule('monthlyRevenue', '月营业额', 'finance', ['monthly revenue', 'average monthly revenue', 'monthly sales'])],
  [/^(owner\s*first\s*name|principal\s*first\s*name|applicant\s*first\s*name|负责人名|法人名)$/i, rule('ownerFirstName', '负责人名', 'business', ['owner first name', 'principal first name', 'applicant first name'])],
  [/^(owner\s*last\s*name|principal\s*last\s*name|applicant\s*last\s*name|负责人姓|法人姓)$/i, rule('ownerLastName', '负责人姓', 'business', ['owner last name', 'principal last name', 'applicant last name'])],
  [/^(owner\s*name|principal\s*name|authorized\s*signer|business\s*owner|负责人姓名|法人姓名)$/i, rule('ownerName', '负责人姓名', 'business', ['owner name', 'principal name', 'authorized signer', 'business owner'])],
  [/^(owner\s*title|title|position|job\s*title|职位|职务)$/i, rule('ownerTitle', '负责人职位', 'business', ['owner title', 'title', 'position', 'job title'])],
  [/^(ownership|ownership\s*percent|ownership\s*percentage|owner\s*percent|持股比例)$/i, rule('ownershipPercentage', '持股比例', 'business', ['ownership percent', 'ownership percentage', 'owner percent'])],
  [/^(loan\s*amount|amount\s*requested|requested\s*amount|requested\s*loan\s*amount|financing\s*amount|贷款金额|申请金额)$/i, rule('loanAmount', '贷款金额', 'loan', ['loan amount', 'amount requested', 'requested loan amount', 'financing amount'])],
  [/^(loan\s*purpose|purpose|use\s*of\s*funds|funding\s*purpose|贷款用途|资金用途)$/i, rule('loanPurpose', '贷款用途', 'loan', ['loan purpose', 'purpose', 'use of funds', 'funding purpose'])],
  [/^(loan\s*term|term|requested\s*term|repayment\s*term|贷款期限|还款期限)$/i, rule('loanTerm', '贷款期限', 'loan', ['loan term', 'requested term', 'repayment term'])],
  [/^(loan\s*type|product|financing\s*type|贷款类型)$/i, rule('loanType', '贷款类型', 'loan', ['loan type', 'financing type', 'product'])],
  [/^(credit\s*score|fico|fico\s*score|信用分|信用评分)$/i, rule('creditScore', '信用分', 'finance', ['credit score', 'fico', 'fico score'])],
  [/^(annual\s*income|gross\s*annual\s*income|yearly\s*income|个人年收入)$/i, rule('annualIncome', '个人年收入', 'finance', ['annual income', 'gross annual income', 'yearly income'])],
  [/^(monthly\s*income|gross\s*monthly\s*income|个人月收入)$/i, rule('monthlyIncome', '个人月收入', 'finance', ['monthly income', 'gross monthly income'])],
  [/^(housing\s*status|residential\s*status|own\s*or\s*rent|居住状态)$/i, rule('housingStatus', '居住状态', 'finance', ['housing status', 'residential status', 'own or rent'])],
  [/^(monthly\s*rent|mortgage|rent\s*payment|mortgage\s*payment|月租|月供)$/i, rule('monthlyHousingPayment', '月租/月供', 'finance', ['monthly rent', 'mortgage payment', 'rent payment'])],
  [/^(employment\s*status|employment|employed|工作状态|就业状态)$/i, rule('employmentStatus', '就业状态', 'employment', ['employment status', 'employment', 'employed'])],
  [/^(employer|employer\s*name|company\s*employer|工作单位|雇主)$/i, rule('employerName', '雇主名称', 'employment', ['employer', 'employer name', 'company employer'])],
  [/^(job\s*title|occupation\s*title|职位名称)$/i, rule('jobTitle', '职位名称', 'employment', ['job title', 'occupation title', 'position'])],
  [/^(years\s*employed|time\s*employed|employment\s*length|工作年限)$/i, rule('yearsEmployed', '工作年限', 'employment', ['years employed', 'time employed', 'employment length'])],
  [/^(bank|bank\s*name|financial\s*institution|银行|银行名称)$/i, rule('bankName', '银行名称', 'finance', ['bank', 'bank name', 'financial institution'], 'private')],
  [/^(routing|routing\s*number|aba|aba\s*number|路由号)$/i, rule('routingNumber', 'Routing Number', 'finance', ['routing number', 'aba number'], 'secret')],
  [/^(account\s*number|bank\s*account|checking\s*account|账户号|银行账号)$/i, rule('bankAccountNumber', '银行账号', 'finance', ['account number', 'bank account', 'checking account'], 'secret')],
  [/^(account\s*type|bank\s*account\s*type|账户类型)$/i, rule('bankAccountType', '账户类型', 'finance', ['account type', 'bank account type'], 'private')],
  [/^(currentcoverage|currentcoveragetype|current\s*coverage\s*type)$/i, rule('currentCoverageType', '当前保险类型', 'insurance', ['current coverage type', 'coverage type'])],
  [/^(currentinsurancecompany|current\s*insurance\s*company|insurance\s*company)$/i, rule('currentInsuranceCompany', '当前保险公司', 'insurance', ['insurance company', 'current insurance company'])],
  [/^(expirationdate|expiration\s*date)$/i, rule('insuranceExpirationDate', '保险到期日', 'insurance', ['expiration date', 'insurance expiration'])],
  [/^(insuredsincedate|insured\s*since)$/i, rule('insuredSinceDate', '投保开始日', 'insurance', ['insured since', 'insured since date'])],
  [/^(requestedcoveragetype|requested\s*coverage\s*type)$/i, rule('requestedCoverageType', '期望保险类型', 'insurance', ['requested coverage type'])],
  [/^(requestedbodilyinjury|bodily\s*injury)$/i, rule('requestedBodilyInjury', '人身伤害保额', 'insurance', ['bodily injury', 'requested bodily injury'])],
  [/^(requestedpropertydamage|property\s*damage)$/i, rule('requestedPropertyDamage', '财产损失保额', 'insurance', ['property damage', 'requested property damage'])],
  [/^(requesteduninsuredmotorist|uninsured\s*motorist)$/i, rule('requestedUninsuredMotorist', '无保险驾驶人保额', 'insurance', ['uninsured motorist'])],
  [/^(relationshiptoapplicant|relationshoptoapplicant|relationship)$/i, rule('relationshipToApplicant', '与申请人关系', 'driver', ['relationship to applicant', 'relationship'])],
  [/^(dui)$/i, rule('dui', 'DUI', 'driver', ['dui', 'driving under influence'])],
  [/^(licensedstate|licensed\s*state|license\s*state)$/i, rule('licensedState', '驾照州', 'driver', ['licensed state', 'license state'])],
  [/^(requiressr22|requires\s*sr22|sr22)$/i, rule('requiresSr22', '是否需要 SR22', 'driver', ['sr22', 'requires sr22'])],
  [/^(bankruptcy|破产)$/i, rule('bankruptcy', '是否破产', 'driver', ['bankruptcy', '破产'])],
  [/^(creditrating|credit\s*rating)$/i, rule('creditRating', '信用评级', 'driver', ['credit rating'])],
  [/^(licenseeversuspented|licenseeversuspended|license\s*ever\s*suspended)$/i, rule('licenseEverSuspended', '驾照是否被吊销', 'driver', ['license suspended', 'license ever suspended'])],
  [/^(residencetype|residence\s*type)$/i, rule('residenceType', '居住类型', 'driver', ['residence type'])],
  [/^(make|vehicle\s*make|品牌|车辆品牌)$/i, rule('vehicleMake', '车辆品牌', 'vehicle', ['make', 'vehicle make', '车辆品牌'])],
  [/^(model|vehicle\s*model|车型)$/i, rule('vehicleModel', '车型', 'vehicle', ['model', 'vehicle model', '车型'])],
  [/^(year|vehicle\s*year|年份)$/i, rule('vehicleYear', '年份', 'vehicle', ['year', 'vehicle year', '年份'])],
  [/^(date|created\s*date|日期)$/i, rule('sourceDate', '日期', 'custom', ['date', '日期'])]
];

export async function parseFillProfileImportFile(file: File): Promise<FillProfileImportPreview> {
  const lowerName = file.name.toLowerCase();

  if (lowerName.endsWith('.kpfill') || lowerName.endsWith('.json')) {
    return parseKpFill(file);
  }

  if (lowerName.endsWith('.csv')) {
    const text = await file.text();
    return buildPreview(file.name, 'csv', parseCsvRows(text));
  }

  if (lowerName.endsWith('.xlsx')) {
    const sheets = await parseXlsx(file);
    return buildPreview(file.name, 'xlsx', sheets[0]?.rows ?? []);
  }

  throw new Error('UNSUPPORTED_FILL_IMPORT_FILE');
}

export function exportFillProfilesKpFill(profiles: FillProfile[]): string {
  const payload: KpFillExport = {
    format: 'keypilot-fill-profiles',
    version: 1,
    exportedAt: new Date().toISOString(),
    profiles: profiles.map((profile) => ({
      ...profile,
      fields: appendInferredCountryField(profile.fields, profile.countryCode, shouldAddInferredCountryFromFields(profile.fields, profile.countryCode)),
      source: 'kpfill',
      lastUsedAt: undefined
    }))
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

function rule(
  key: string,
  label: string,
  group: FillFieldGroup,
  aliases: string[],
  sensitivity: FillFieldSensitivity = 'normal'
): HeaderRule {
  return { key, label, group, aliases, sensitivity };
}

async function parseKpFill(file: File): Promise<FillProfileImportPreview> {
  const parsed = JSON.parse(await file.text()) as { profiles?: FillProfile[] } | FillProfile[];
  const profiles = Array.isArray(parsed) ? parsed : parsed.profiles ?? [];
  const normalizedProfiles = profiles.map((profile) => ({
    ...profile,
    id: crypto.randomUUID(),
    fields: appendInferredCountryField(profile.fields, profile.countryCode, shouldAddInferredCountryFromFields(profile.fields, profile.countryCode)),
    source: 'kpfill' as const,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }));
  const fieldCount = normalizedProfiles.reduce((sum, profile) => sum + profile.fields.length, 0);
  const sensitiveFieldCount = normalizedProfiles.reduce((sum, profile) => sum + profile.fields.filter((field) => field.sensitivity === 'secret').length, 0);

  return {
    sourceName: file.name,
    sourceType: 'kpfill',
    totalRows: normalizedProfiles.length,
    importableRows: normalizedProfiles.length,
    fieldCount,
    countryCode: normalizedProfiles[0]?.countryCode ?? DEFAULT_COUNTRY,
    category: normalizedProfiles[0]?.category ?? 'custom',
    sensitiveFieldCount,
    emptyFieldCount: 0,
    headers: [],
    profiles: normalizedProfiles,
    sampleProfiles: normalizedProfiles.slice(0, 5)
  };
}

async function parseXlsx(file: File): Promise<ParsedSheet[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const zip = unzipSync(bytes);
  const decoder = new TextDecoder();
  const xml = (path: string) => {
    const fileBytes = zip[path];
    return fileBytes ? decoder.decode(fileBytes) : '';
  };
  const sharedStrings = readSharedStrings(xml('xl/sharedStrings.xml'));
  const workbook = parseXml(xml('xl/workbook.xml'));
  const rels = parseWorkbookRelationships(xml('xl/_rels/workbook.xml.rels'));
  const sheetNodes = Array.from(workbook.getElementsByTagName('sheet'));
  const sheets = sheetNodes.length
    ? sheetNodes.map((sheet, index) => {
        const name = sheet.getAttribute('name') || `Sheet${index + 1}`;
        const relId = sheet.getAttribute('r:id') || sheet.getAttribute('id') || '';
        const target = rels.get(relId) || `worksheets/sheet${index + 1}.xml`;
        return {
          name,
          rows: parseWorksheet(xml(`xl/${target.replace(/^\/?xl\//, '')}`), sharedStrings)
        };
      })
    : [{ name: 'Sheet1', rows: parseWorksheet(xml('xl/worksheets/sheet1.xml'), sharedStrings) }];

  return sheets.filter((sheet) => sheet.rows.length);
}

function parseXml(source: string): Document {
  return new DOMParser().parseFromString(source || '<root />', XML_TYPE);
}

function parseWorkbookRelationships(source: string): Map<string, string> {
  const doc = parseXml(source);
  const rels = new Map<string, string>();
  Array.from(doc.getElementsByTagName('Relationship')).forEach((node) => {
    const id = node.getAttribute('Id');
    const target = node.getAttribute('Target');
    if (id && target) rels.set(id, target);
  });
  return rels;
}

function readSharedStrings(source: string): string[] {
  if (!source) return [];
  const doc = parseXml(source);
  return Array.from(doc.getElementsByTagName('si')).map((si) =>
    Array.from(si.getElementsByTagName('t'))
      .map((node) => node.textContent ?? '')
      .join('')
  );
}

function parseWorksheet(source: string, sharedStrings: string[]): string[][] {
  if (!source) return [];
  const doc = parseXml(source);
  const rows: string[][] = [];
  Array.from(doc.getElementsByTagName('row')).forEach((rowNode) => {
    const row: string[] = [];
    Array.from(rowNode.getElementsByTagName('c')).forEach((cell) => {
      const ref = cell.getAttribute('r') ?? '';
      const columnIndex = cellRefToColumnIndex(ref) ?? row.length;
      row[columnIndex] = readCellValue(cell, sharedStrings);
    });
    rows.push(row.map((value) => value ?? ''));
  });
  return rows;
}

function cellRefToColumnIndex(ref: string): number | null {
  const letters = ref.match(/[A-Z]+/i)?.[0];
  if (!letters) return null;
  return letters
    .toUpperCase()
    .split('')
    .reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

function readCellValue(cell: Element, sharedStrings: string[]): string {
  const type = cell.getAttribute('t');
  if (type === 'inlineStr') {
    return Array.from(cell.getElementsByTagName('t'))
      .map((node) => node.textContent ?? '')
      .join('');
  }

  const value = cell.getElementsByTagName('v')[0]?.textContent ?? '';
  if (type === 's') return sharedStrings[Number(value)] ?? '';
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE';
  return value;
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && quoted && next === '"') {
      field += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (char === ',' && !quoted) {
      row.push(field);
      field = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') index += 1;
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = '';
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function buildPreview(sourceName: string, sourceType: 'xlsx' | 'csv', rows: string[][]): FillProfileImportPreview {
  const headerIndex = detectHeaderRow(rows);
  const headers = (rows[headerIndex] ?? []).map((value) => value.trim());
  const mappings = headers.map(mapHeader);
  const dataRows = rows.slice(headerIndex + 1).filter((row) => row.some((value) => String(value ?? '').trim()));
  const countryCode = inferCountryCode(headers, dataRows.slice(0, 20));
  const category = inferCategory(headers);
  const addInferredCountry = shouldAddInferredCountryField(headers, dataRows.slice(0, 20), countryCode);
  let emptyFieldCount = 0;
  const now = Date.now();
  const profiles: FillProfile[] = [];
  dataRows.forEach((row, index) => {
    const fields = appendInferredCountryField(mappings.reduce<FillField[]>((result, mapping, columnIndex) => {
      const rawValue = String(row[columnIndex] ?? '').trim();
      if (!rawValue) {
        emptyFieldCount += 1;
        return result;
      }
      result.push({
        key: mapping.key,
        label: mapping.label,
        value: normalizeFieldValue(mapping.key, rawValue),
        group: mapping.group,
        sensitivity: mapping.sensitivity,
        aliases: mapping.aliases,
        sourceColumn: mapping.column
      });
      return result;
    }, []), countryCode, addInferredCountry);

    if (!fields.length) return;

    profiles.push({
      id: crypto.randomUUID(),
      title: buildProfileTitle(category, countryCode, index + 1, fields),
      countryCode,
      category,
      folder: fillProfileFolder(category),
      fields,
      tags: fillProfileTags(category, countryCode),
      source: sourceType === 'xlsx' ? 'excel' : sourceType,
      createdAt: now,
      updatedAt: now
    });
  });
  const sensitiveFieldCount = mappings.filter((mapping) => mapping.sensitivity === 'secret').length;

  return {
    sourceName,
    sourceType,
    totalRows: dataRows.length,
    importableRows: profiles.length,
    fieldCount: mappings.length + (addInferredCountry ? 1 : 0),
    countryCode,
    category,
    sensitiveFieldCount,
    emptyFieldCount,
    headers: mappings,
    profiles,
    sampleProfiles: profiles.slice(0, 5)
  };
}

function detectHeaderRow(rows: string[][]): number {
  let bestIndex = 0;
  let bestScore = -1;
  rows.slice(0, 10).forEach((row, index) => {
    const textCells = row.filter((value) => String(value ?? '').trim() && Number.isNaN(Number(value))).length;
    const score = textCells + row.filter((value) => mapHeader(String(value ?? '')).group !== 'custom').length * 2;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function mapHeader(column: string): FillHeaderMapping {
  const normalized = column.trim();
  const compact = normalized.replace(/[\s_-]+/g, '').toLowerCase();
  const matched = HEADER_RULES.find(([pattern]) => pattern.test(normalized) || pattern.test(compact))?.[1];
  const fallbackKey = toCamelKey(normalized) || `field${Math.random().toString(36).slice(2, 8)}`;

  return {
    column: normalized,
    key: matched?.key ?? fallbackKey,
    label: matched?.label ?? normalized,
    group: matched?.group ?? 'custom',
    sensitivity: matched?.sensitivity ?? inferSensitivity(normalized),
    aliases: matched?.aliases ?? [normalized]
  };
}

function toCamelKey(value: string): string {
  const parts = value
    .replace(/[^A-Za-z0-9\u4e00-\u9fa5]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '';
  return parts
    .map((part, index) => {
      const lower = part.toLowerCase();
      return index === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
}

function inferSensitivity(header: string): FillFieldSensitivity {
  return /(ssn|social|cvv|cvc|card|credit|password|身份证|信用卡|卡号|安全码)/i.test(header) ? 'secret' : 'normal';
}

function countryDetectionText(headers: string[], sampleRows: string[][] = []): string {
  return [
    headers.join(' '),
    ...sampleRows.slice(0, 20).map((row) => row.slice(0, 80).join(' '))
  ].join(' ').toLowerCase();
}

function hasUsCountrySignals(text: string): boolean {
  return /\b(united\s*states|usa|u\.s\.a|u\s*s\s*a|us|state|zip|zipcode|ssn|dui|sr22|coverage|insurance|ein|fein|routing|aba|fico|loan|business|company|licensedstate|requestedcoverage|bodilyinjury|propertydamage)\b/.test(text);
}

function hasCnCountrySignals(text: string): boolean {
  return /(中国|省|市|身份证|手机号|邮编)/.test(text);
}

function inferCountryCode(headers: string[], sampleRows: string[][] = []): string {
  const joined = countryDetectionText(headers, sampleRows);
  if (hasUsCountrySignals(joined)) return 'US';
  if (hasCnCountrySignals(joined)) return 'CN';
  return DEFAULT_COUNTRY;
}

function shouldAddInferredCountryField(headers: string[], sampleRows: string[][], countryCode: string): boolean {
  const hasCountryColumn = headers.some((header) => {
    const mapping = mapHeader(header);
    return mapping.key === 'country' || mapping.key === 'businessCountry';
  });
  if (hasCountryColumn) return false;

  const joined = countryDetectionText(headers, sampleRows);
  if (countryCode === 'US') return hasUsCountrySignals(joined);
  if (countryCode === 'CN') return hasCnCountrySignals(joined);
  return false;
}

function countryNameFromCode(countryCode: string): string {
  const countries: Record<string, string> = {
    US: 'United States',
    CN: 'China',
    CA: 'Canada',
    GB: 'United Kingdom',
    UK: 'United Kingdom',
    AU: 'Australia'
  };
  return countries[countryCode.toUpperCase()] ?? countryCode.toUpperCase();
}

function appendInferredCountryField(fields: FillField[], countryCode: string, shouldAdd: boolean): FillField[] {
  if (!shouldAdd || fields.some((field) => (field.key === 'country' || field.key === 'businessCountry') && field.value.trim())) {
    return fields;
  }

  return [
    ...fields,
    {
      key: 'country',
      label: '国家',
      value: countryNameFromCode(countryCode),
      group: 'address',
      sensitivity: 'normal',
      aliases: ['country', 'country code', 'country/region', 'country region', 'nation', '国家', '国家/地区']
    }
  ];
}

function shouldAddInferredCountryFromFields(fields: FillField[], countryCode: string): boolean {
  if (!['US', 'CN'].includes(countryCode.toUpperCase())) return false;
  if (fields.some((field) => (field.key === 'country' || field.key === 'businessCountry') && field.value.trim())) return false;
  return fields.some((field) =>
    field.group === 'address' ||
    ['address1', 'address2', 'city', 'state', 'postalCode', 'licensedState', 'businessState', 'businessPostalCode'].includes(field.key)
  );
}

function inferCategory(headers: string[]): FillProfileCategory {
  const joined = headers.join(' ').toLowerCase();
  if (/(vehicle|make|model|dui|sr22|coverage|insurance|车险|车辆)/.test(joined)) return 'auto_insurance';
  if (/(loan|financing|funding|amount requested|requested amount|credit score|fico|annual income|monthly income|routing|aba|bank account|贷款|申请金额|资金用途)/.test(joined)) return 'loan';
  if (/(ein|fein|tax id|business|company|dba|entity|naics|revenue|employees|incorporation|公司|企业|营业额|税号)/.test(joined)) return 'business';
  if (/(card|cvv|cvc|信用卡|卡号)/.test(joined)) return 'payment';
  if (/(shipping|billing|address)/.test(joined)) return 'shipping';
  return 'identity';
}

function normalizeFieldValue(key: string, value: string): string {
  if (/^(dob|sourceDate|insuredSinceDate|insuranceExpirationDate)$/i.test(key) && /^\d{5}(\.\d+)?$/.test(value)) {
    return excelSerialDateToIso(Number(value));
  }
  if (/^(dui|requiresSr22|bankruptcy|licenseEverSuspended)$/i.test(key)) {
    if (/^n(o)?$/i.test(value)) return 'No';
    if (/^y(es)?$/i.test(value)) return 'Yes';
  }
  if (key === 'gender') {
    if (/^m$/i.test(value)) return 'Male';
    if (/^f$/i.test(value)) return 'Female';
  }
  return value;
}

function excelSerialDateToIso(serial: number): string {
  const epoch = Date.UTC(1899, 11, 30);
  const date = new Date(epoch + serial * 24 * 60 * 60 * 1000);
  if (Number.isNaN(date.getTime())) return String(serial);
  return date.toISOString().slice(0, 10);
}

function buildProfileTitle(category: FillProfileCategory, countryCode: string, index: number, fields: FillField[]): string {
  if (category === 'auto_insurance') return `车险_${countryCode}${String(index).padStart(4, '0')}`;
  if (category === 'loan') {
    const businessName = fields.find((field) => field.key === 'businessName')?.value ?? '';
    const ownerName = fields.find((field) => field.key === 'ownerName')?.value ?? '';
    const loanAmount = fields.find((field) => field.key === 'loanAmount')?.value ?? '';
    const name = businessName || ownerName || fields.find((field) => field.key === 'fullName')?.value || '';
    return name || loanAmount ? `贷款_${compactTitlePart(name || loanAmount)}_${countryCode}${String(index).padStart(4, '0')}` : `贷款_${countryCode}${String(index).padStart(4, '0')}`;
  }
  if (category === 'business') {
    const businessName = fields.find((field) => field.key === 'businessName')?.value ?? fields.find((field) => field.key === 'dbaName')?.value ?? '';
    return businessName ? `公司_${compactTitlePart(businessName)}` : `公司资料_${countryCode}${String(index).padStart(4, '0')}`;
  }
  const firstName = fields.find((field) => field.key === 'firstName')?.value ?? '';
  const lastName = fields.find((field) => field.key === 'lastName')?.value ?? '';
  const fullName = fields.find((field) => field.key === 'fullName')?.value ?? `${firstName} ${lastName}`.trim();
  return fullName || `身份资料_${countryCode}${String(index).padStart(4, '0')}`;
}

function fillProfileFolder(category: FillProfileCategory): string | undefined {
  if (category === 'auto_insurance') return ROOT_FOLDER;
  if (category === 'loan') return LOAN_FOLDER;
  if (category === 'business') return BUSINESS_FOLDER;
  return undefined;
}

function fillProfileTags(category: FillProfileCategory, countryCode: string): string[] {
  if (category === 'auto_insurance') return ['车险', countryCode];
  if (category === 'loan') return ['贷款', countryCode];
  if (category === 'business') return ['公司', countryCode];
  return [countryCode];
}

function compactTitlePart(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 32);
}
