# The targeted word lists of the privacy screen (cloud-first C1, plan 4.4). Part of the code layer: no model, a named rule
# per hit, a hit holds the sentence and nothing downstream can release it. privacy.code_hit calls hit() after the older
# rules, so every older rule keeps its name.
#   money        identifiers and secrets only: account and routing numbers, IBANs, Luhn-valid card numbers, SSN and tax ID
#                shapes, a password / passcode / PIN with its value. Ordinary business money words (budget, pricing, price,
#                invoice, rate, fee, cost, revenue, salary bands) are never on a list.
#   health       a condition, injury or treatment word, when a person is the subject: "I", "my" (rule wl-condition,
#                wl-injury, wl-treatment, wl-sick). Figurative and business uses ("healthy pipeline", "pain point", "sick of",
#                "therapy market") pass.
#   third-party  the same words, or a family crisis (died, funeral, divorce, rehab, arrested), when the person is a name
#                from the call, he / she / they or a relative, and the speaker is not the subject.
# Written from general knowledge before any real call line was read; the lists below are the whole rulebook.
import re

def words(*phrases): return '|'.join(phrases)

# ---------- money: identifiers and secrets ----------

DIGITS = r'(?:\d[ -]?){5,}'
IBAN = re.compile(r'\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b')
ACCOUNT = re.compile(r'(?i:\b(?:account|acct|routing|aba|swift|sort code)\b)(?:\W+(?:number|no|num|#))?\W+(?:is |was )?' + DIGITS)
TAX_ID = re.compile(r'\b\d{3}-\d{2}-\d{4}\b|\b\d{2}-\d{7}\b|(?i:\b(?:ssn|social security(?: number)?|tax id|taxpayer id|itin|ein|tin)\b)\W+(?:is |was |number )?' + r'(?:\d[ -]?){8,}')
SECRET_WORD = r'(?:password|passcode|passphrase|(?-i:PIN)|pin code|pin number)'
NOT_A_VALUE = r'(?:required|reset|resets|manager|managers|policy|policies|expired|expires|wrong|incorrect|correct|changed|change|too|not|strong|weak|protected|field|screen|prompt|flow|page|rule|rules|link|email|emails|check|checks|issue|issues|problem|problems|there|here|a|an|the|for|in|on|and|or|but|so|because)'
PASSWORD = re.compile(r"(?i:\b(?:my|his|her|their|your|the|new|temporary|wifi|wi-fi|login|admin)\s+)" + SECRET_WORD + r"(?i:\s+(?:is|was|will be|:|=)\s*|\s*[:=]\s*)(?!(?i:" + NOT_A_VALUE + r")\b)\S+")

def money_hit(s):
    from privacy import card_numbers   # imported late: privacy imports this module
    if card_numbers(s): return 'money', 'wl-card'
    if IBAN.search(s): return 'money', 'wl-iban'
    if ACCOUNT.search(s): return 'money', 'wl-account'
    if TAX_ID.search(s): return 'money', 'wl-tax-id'
    if PASSWORD.search(s): return 'money', 'wl-password'
    return None

# ---------- health: conditions, injuries, treatment ----------

BODY = words('knees?', 'ankles?', 'shoulders?', 'wrists?', 'hips?', 'necks?', 'elbows?', 'spine', 'legs?', 'ribs?', 'collarbone', 'back', 'acl', 'mcl', 'meniscus',
             'achilles', 'hamstrings?', 'ligaments?', 'tendons?', 'rotator cuff', 'jaw', 'teeth', 'tooth')
OWNED = r"(?:my|his|her|their|your|[A-Z][a-z]+'s)"

GROUPS = {
    'wl-condition': words(
        'cancer', 'tumou?rs?', 'leukemia', 'lymphoma', 'chemo', 'chemotherapy', 'radiation therapy', 'dialysis', 'transplant', 'diabet(?:es|ic)', 'asthma', 'arthritis',
        'epilepsy', 'seizures?', 'strokes?', 'heart attack', 'heart disease', 'high blood pressure', 'hypertension', 'migraines?', 'concussions?', 'covid', 'the flu',
        'pneumonia', 'infections?', 'food poisoning', 'adhd', '(?-i:ADD)', 'autism', 'autistic', 'bipolar', 'schizophrenia', 'ptsd', 'ocd', 'depression', 'depressed',
        'anxiety', 'panic attacks?', 'insomnia', 'eating disorder', 'anorexia', 'bulimia', 'addiction', 'alcoholism', 'pregnan(?:t|cy)', 'miscarriage',
        'morning sickness', 'infertility', 'ivf', 'lupus', 'crohn\'?s', 'allerg(?:y|ies|ic)', 'chronic (?:pain|illness|condition|fatigue)', 'burn ?out (?:leave|diagnosis)'),
    'wl-injury': words(
        'injur(?:y|ies|ed)', 'whiplash', 'herniated disc', 'slipped disc', 'carpal tunnel', 'tendon?itis', 'fractures?', 'broken bones?', 'sprains?', 'sprained',
        # a verb and a body part: "hurt my knee", "tore his ACL", "pulled a hamstring"
        r'(?:hurt|hurting|tore|torn|pulled|strained|twisted|broke|broken|fractured|dislocated|ruptured|bruised|messed up|banged up|injured|sprained)\b[^.?!]{0,20}?\b(?:' + BODY + r')\b',
        # a body part and a complaint: "my knee hurts", "his back is killing him", "knee surgery", "back pain"
        OWNED + r' (?:' + BODY + r')\b[^.?!]{0,15}?\b(?:hurts?|hurting|aches?|aching|is killing|are killing|swollen|gave out|giving out|acting up|bothering|problem|injury|pain|surgery|issues?)\b',
        r'\b(?:' + BODY + r') (?:pain|surgery|injury|replacement)\b', r'pain in (?:my|his|her|their) (?:' + BODY + r')\b', r'\bin (?:a lot of |so much |severe )?pain\b',
        r"can'?t (?:walk|stand|run|lift|bend|sit|sleep)(?: \w+){0,2} (?:for (?:long|more than|very long|hours)|without|properly|anymore|at all|right now)"),
    'wl-treatment': words(
        'surgery', 'surgeon', 'diagnos(?:is|ed|e)', 'prescri(?:bed|ption)', 'medication', 'meds', 'antibiotics', 'insulin', 'antidepressants?', 'painkillers?',
        'therapy', 'therapist', 'physio', 'physical therapy', 'counsel(?:l)?ing', 'rehab', 'icu', 'emergency room', 'urgent care', 'mri', 'x-ray', 'biopsy', 'stitches',
        'crutches', 'wheelchair', 'blood tests?', 'check-?up', 'sick leave', 'medical leave', 'disability leave', "doctor'?s? (?:appointment|visit|note|orders)", 'dentist appointment',
        '(?:see|seeing|saw|seen|visit|visited|visiting|call|called) (?:a|the|my|his|her|their) (?:doctor|dr|specialist|dentist|gp|physician)', '(?:my|his|her|their) (?:doctor|physician|specialist)',
        '(?:in|into|to|at|from|out of|left|leave) the hospital', 'hospitali[sz]ed', 'admitted to (?:the )?(?:hospital|er)', '(?:in|at|to|from) the er',
        'recovering from', 'recovery from (?:surgery|an? \\w+)'),
    'wl-sick': r"(?:was|am|is|are|been|got|getting|gets|feel|feels|feeling|felt|call(?:ed)? in|stayed home|home) (?:really |very |so |pretty |quite )?(?:sick|ill|nauseous)\b(?! of)(?! and tired)|under the weather|sick day",
}
HEALTH = {rule: re.compile(r'\b(?:' + body + r')\b', re.I) for rule, body in GROUPS.items()}

# Uses that are not about a person's health. A hit inside one of these spans is dropped before the lists run.
FIGURATIVE = re.compile(r"(?i:pain points?|pain in the (?:neck|ass|butt)|sick (?:of|and tired of)|healthy (?:pipeline|margins?|growth|competition|skepticism|debate|ecosystem)|the great depression"
                        r"|economic depression|retail therapy|therapy (?:dog|market|area|space|company|companies|app|apps|products?|startup)|back[- ]?end|back ?office|back to|back up|backup|backlog"
                        r"|at the hip|hip hop|cost of the hospital|hospital (?:foundation|board|network|group|systems?|chain|partner|procurement)|add (?:to|on|up|in|an?|the|it|that|them)\b)")
# Sentences about a product or a market, where a condition word names a topic, not a person.
BUSINESS = re.compile(r"(?i:\b(?:drugs?|trials?|markets?|indications?|payers?|fda|biotech|pharma|launch|approval|customers?|clients?|vendors?|startups?|pipeline|revenue|device|devices|app|apps|platform|product|products|portfolio|diagnostics|sell|selling|sells|invest|investing|case study|research|study|studies|patients|health ?care|insurers?)\b)")

# ---------- who the sentence is about ----------

FIRST = re.compile(r"(?i:\b(?:i|i'm|i've|i'd|i'll|me|my|myself|mine)\b)")
THIRD = re.compile(r"(?i:\b(?:he|she|they|he's|she's|they're|his|her|their|him|them|hers)\b)")
RELATIVE = re.compile(r"(?i:\b(?:mom|mother|dad|father|wife|husband|brother|sister|son|daughter|kid|kids|baby|grandma|grandmother|grandpa|grandfather|partner|girlfriend|boyfriend|fianc[eé]e?|parents?|uncle|aunt|cousin)\b)")
CRISIS = re.compile(r"(?i:\b(?:died|dying|passed away|passed on|death in the family|funeral|wake|bereavement|divorce[ds]?|divorcing|separated|custody|in rehab|rehab|arrested|jail|family emergency"
                    r"|lost (?:his|her|their|a) (?:job|mom|mother|dad|father|wife|husband|brother|sister|son|daughter|baby)|going through a (?:hard|rough|tough|difficult) (?:time|patch)|struggling with)\b)")

def names_in(s, people):
    # A call name counts when it is in the sentence as a whole word (a first or full name, case-sensitive, possessive too).
    for p in people or ():
        for part in {p.strip(), p.strip().split(' ')[0]}:
            if part and re.search(r"\b" + re.escape(part) + r"\b", s): return True
    return False

def about_person(s, people):
    # 'first' when the speaker is the subject, 'third' when a call name, he / she / they or a relative is, else None.
    if RELATIVE.search(s) and not re.search(r"(?i:\bi\b[^.?!]{0,30}\b(?:hurt|tore|broke|have|had|am|was|got)\b)", s): return 'third'   # "my mom is sick" is about the mom
    if FIRST.search(s): return 'first'
    if names_in(s, people) or THIRD.search(s): return 'third'
    return None

def health_rule(s):
    for rule, rx in HEALTH.items():
        if rx.search(s): return rule
    return None

def health_hit(s, people):
    who = about_person(s, people)
    if who is None: return None
    flat = FIGURATIVE.sub(' ', s)
    rule = health_rule(flat)
    if rule is None and who == 'third' and CRISIS.search(flat): rule = 'wl-third-party'
    if rule is None: return None
    if BUSINESS.search(flat) and not FIRST.search(flat) and not names_in(s, people): return None   # "they sell to hospital systems"
    if BUSINESS.search(flat) and re.search(r"(?i:\b(?:work(?:ed|ing|s)?|focus(?:ed|es)?|study|studied|research(?:ing)?|build(?:ing)?|built)\b)", flat): return None   # "I work on cancer drugs"
    return ('health', rule) if who == 'first' else ('third-party', 'wl-third-party')

def hit(sentence, people=()):
    # (category, rule id) for the first list that fires on one sentence, or None. `people` are the call's other names.
    s = ' '.join(sentence.split())
    return money_hit(s) or health_hit(s, people)
