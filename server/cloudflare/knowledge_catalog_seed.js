// The owner's reference list (77 items) as catalog entries for the Knowledge Library (knowledge_library.js).
// Every entry is catalogued with its bibliographic data, subject, tags and links. No text is stored here: the books,
// comics and films are under copyright, and the documentation and papers are not licensed for storage. An owner
// text, a public-domain work or an openly licensed work can be indexed later with its own licence on record.
// Movies and comics are inspiration for design and narrative; their fictional technology is never evidence.
import { KnowledgeLibrary } from './knowledge_library.js';

// [title, creator, category, kind, subcategory, tags, source_url, note]
const BOOK = 'book';
const DOC = 'documentation';
const PAPER = 'paper';

export const KNOWLEDGE_CATALOG_SEED = Object.freeze([
  // 1–40: books
  ['Artificial Intelligence: A Modern Approach', 'Stuart Russell and Peter Norvig', 'ai_agents', BOOK, 'Artificial Intelligence and Intelligent Agents', ['agents', 'search', 'planning', 'reasoning']],
  ['AI Engineering', 'Chip Huyen', 'ai_agents', BOOK, 'Artificial Intelligence and Intelligent Agents', ['llm', 'evaluation', 'deployment', 'agents']],
  ['The Pragmatic Programmer', 'Andrew Hunt and David Thomas', 'software_engineering', BOOK, 'Software Engineering and Programming', ['craft', 'debugging', 'refactoring', 'tooling']],
  ['Clean Architecture', 'Robert C. Martin', 'software_engineering', BOOK, 'Software Engineering and Programming', ['architecture', 'dependencies', 'boundaries']],
  ['Algorithms to Live By', 'Brian Christian and Tom Griffiths', 'planning_decisions', BOOK, 'Autonomous Planning and Decision-Making', ['decisions', 'heuristics', 'scheduling']],
  ['Planning Algorithms', 'Steven M. LaValle', 'planning_decisions', BOOK, 'Autonomous Planning and Decision-Making', ['planning', 'search', 'motion planning']],
  ['Deep Learning', 'Ian Goodfellow, Yoshua Bengio and Aaron Courville', 'machine_learning', BOOK, 'Machine Learning and Neural Networks', ['neural networks', 'optimization', 'deep learning']],
  ['Hands-On Machine Learning with Scikit-Learn, Keras, and TensorFlow', 'Aurélien Géron', 'machine_learning', BOOK, 'Machine Learning and Neural Networks', ['machine learning', 'scikit-learn', 'keras', 'tensorflow']],
  ['Make It Stick', 'Peter C. Brown, Henry L. Roediger III and Mark A. McDaniel', 'memory_cognition', BOOK, 'Memory, Learning and Cognitive Science', ['retrieval practice', 'spacing', 'learning']],
  ['How We Learn', 'Benedict Carey', 'memory_cognition', BOOK, 'Memory, Learning and Cognitive Science', ['learning', 'memory', 'study']],
  ['Introduction to Information Retrieval', 'Christopher Manning, Prabhakar Raghavan and Hinrich Schütze', 'search_rag', BOOK, 'Knowledge Retrieval, Search and RAG', ['indexing', 'ranking', 'retrieval', 'evaluation']],
  ['Relevant Search', 'Doug Turnbull and John Berryman', 'search_rag', BOOK, 'Knowledge Retrieval, Search and RAG', ['relevance', 'search engines', 'ranking']],
  ['The Scout Mindset', 'Julia Galef', 'reasoning_fact_checking', BOOK, 'Critical Thinking, Logic and Reasoning', ['reasoning', 'bias', 'calibration']],
  ['Superforecasting', 'Philip Tetlock and Dan Gardner', 'reasoning_fact_checking', BOOK, 'Critical Thinking, Logic and Reasoning', ['forecasting', 'probability', 'calibration']],
  ['Release It!', 'Michael T. Nygard', 'debugging_reliability', BOOK, 'Debugging, Reliability and Recovery', ['stability', 'failure', 'circuit breakers']],
  ['Site Reliability Engineering', 'Betsy Beyer, Chris Jones, Jennifer Petoff and Niall Richard Murphy (editors)', 'debugging_reliability', BOOK, 'Debugging, Reliability and Recovery', ['sre', 'monitoring', 'incidents', 'reliability']],
  ['Speech and Language Processing', 'Daniel Jurafsky and James H. Martin', 'natural_language_speech', BOOK, 'Speech, Language and Voice Interfaces', ['nlp', 'speech', 'language models']],
  ['Designing Voice User Interfaces', 'Cathy Pearl', 'natural_language_speech', BOOK, 'Speech, Language and Voice Interfaces', ['voice ui', 'dialogue', 'accessibility']],
  ['Emotional Intelligence', 'Daniel Goleman', 'psychology_emotion', BOOK, 'Psychology and Emotional Intelligence', ['emotion', 'empathy', 'self-regulation']],
  ['Nonviolent Communication', 'Marshall B. Rosenberg', 'psychology_emotion', BOOK, 'Psychology and Emotional Intelligence', ['communication', 'empathy', 'needs']],
  ['The Design of Everyday Things', 'Don Norman', 'communication_accessibility', BOOK, 'Accessibility and Human-Computer Interaction', ['design', 'affordances', 'usability']],
  ['A Web for Everyone', 'Sarah Horton and Whitney Quesenbery', 'communication_accessibility', BOOK, 'Accessibility and Human-Computer Interaction', ['accessibility', 'inclusive design', 'web']],
  ['Security Engineering', 'Ross Anderson', 'cybersecurity', BOOK, 'Cybersecurity and Privacy', ['security', 'privacy', 'threat models']],
  ['Threat Modeling', 'Adam Shostack', 'cybersecurity', BOOK, 'Cybersecurity and Privacy', ['threat modeling', 'security design']],
  ['The Art of Statistics', 'David Spiegelhalter', 'math_statistics', BOOK, 'Mathematics, Probability and Statistics', ['statistics', 'uncertainty', 'data']],
  ['Introduction to Probability', 'Joseph Blitzstein and Jessica Hwang', 'math_statistics', BOOK, 'Mathematics, Probability and Statistics', ['probability', 'distributions', 'expectation']],
  ['Systematic Trading', 'Robert Carver', 'trading_risk', BOOK, 'Trading and Risk Management', ['systematic trading', 'position sizing', 'risk']],
  ['Evidence-Based Technical Analysis', 'David Aronson', 'trading_risk', BOOK, 'Trading and Risk Management', ['backtesting', 'statistics', 'evidence']],
  ['Trading and Exchanges', 'Larry Harris', 'financial_markets', BOOK, 'Quantitative Finance and Market Execution', ['market structure', 'execution', 'exchanges']],
  ['Algorithmic Trading', 'Ernest P. Chan', 'financial_markets', BOOK, 'Quantitative Finance and Market Execution', ['algorithmic trading', 'backtesting', 'execution']],
  ['The E-Myth Revisited', 'Michael E. Gerber', 'business_management', BOOK, 'Business and Entrepreneurship', ['business systems', 'entrepreneurship']],
  ['High Output Management', 'Andrew S. Grove', 'business_management', BOOK, 'Business and Entrepreneurship', ['management', 'output', 'teams']],
  ['Modern Robotics', 'Kevin M. Lynch and Frank C. Park', 'robotics_automation', BOOK, 'Robotics and Automation', ['kinematics', 'dynamics', 'control']],
  ['Feedback Systems', 'Karl J. Åström and Richard M. Murray', 'robotics_automation', BOOK, 'Robotics and Automation', ['feedback', 'control', 'systems']],
  ['Story', 'Robert McKee', 'creative_writing', BOOK, 'Creative Writing and Screenwriting', ['story structure', 'screenwriting', 'character']],
  ['The Anatomy of Story', 'John Truby', 'creative_writing', BOOK, 'Creative Writing and Screenwriting', ['story structure', 'character', 'plot']],
  ["The Animator's Survival Kit", 'Richard Williams', 'animation_games', BOOK, 'Animation, Character Design and Game Development', ['animation', 'timing', 'motion']],
  ['The Art of Game Design', 'Jesse Schell', 'animation_games', BOOK, 'Animation, Character Design and Game Development', ['game design', 'play', 'mechanics']],
  ['Made to Stick', 'Chip Heath and Dan Heath', 'marketing_video', BOOK, 'Marketing and Communication', ['messaging', 'stickiness', 'communication']],
  ['Contagious', 'Jonah Berger', 'marketing_video', BOOK, 'Marketing and Communication', ['word of mouth', 'marketing', 'sharing']],

  // 41–52: comics and graphic novels (creative_writing and animation_games)
  ['Watchmen', 'Alan Moore and Dave Gibbons', 'creative_writing', 'comic', 'Comics and Graphic Novels', ['comics', 'narrative structure', 'panel composition']],
  ['Batman: Year One', 'Frank Miller and David Mazzucchelli', 'creative_writing', 'comic', 'Comics and Graphic Novels', ['comics', 'origin story', 'visual storytelling']],
  ['Understanding Comics', 'Scott McCloud', 'animation_games', 'comic', 'Comics and Graphic Novels', ['comics theory', 'panel composition', 'visual language']],
  ['Making Comics', 'Scott McCloud', 'animation_games', 'comic', 'Comics and Graphic Novels', ['comics craft', 'storytelling', 'panels']],
  ['The Sandman', 'Neil Gaiman and collaborators', 'creative_writing', 'comic', 'Comics and Graphic Novels', ['worldbuilding', 'myth', 'dialogue']],
  ['Ms. Marvel: No Normal', 'G. Willow Wilson and Adrian Alphona', 'creative_writing', 'comic', 'Comics and Graphic Novels', ['character', 'identity', 'emotional expression']],
  ['Daytripper', 'Fábio Moon and Gabriel Bá', 'creative_writing', 'comic', 'Comics and Graphic Novels', ['narrative structure', 'character', 'emotion']],
  ['Saga', 'Brian K. Vaughan and Fiona Staples', 'creative_writing', 'comic', 'Comics and Graphic Novels', ['worldbuilding', 'character design', 'dialogue']],
  ['Invincible', 'Robert Kirkman, Cory Walker and Ryan Ottley', 'animation_games', 'comic', 'Comics and Graphic Novels', ['character design', 'animation inspiration', 'action']],
  ['The Vision', 'Tom King and Gabriel Hernández Walta', 'creative_writing', 'comic', 'Comics and Graphic Novels', ['narrative structure', 'original dialogue', 'character']],
  ['Spider-Man: Life Story', 'Chip Zdarsky and Mark Bagley', 'creative_writing', 'comic', 'Comics and Graphic Novels', ['narrative structure', 'character', 'timeline']],
  ['Comics and Sequential Art', 'Will Eisner', 'animation_games', 'comic', 'Comics and Graphic Novels', ['sequential art', 'visual storytelling', 'panels']],

  // 53–67: movies (inspiration only)
  ['Iron Man', 'Jon Favreau (director)', 'animation_games', 'movie', 'Movies', ['ai assistant', 'tool coordination', 'fiction']],
  ['Iron Man 2', 'Jon Favreau (director)', 'animation_games', 'movie', 'Movies', ['interfaces', 'assistant workflows', 'fiction']],
  ['Her', 'Spike Jonze (director)', 'natural_language_speech', 'movie', 'Movies', ['conversation', 'voice personality', 'fiction']],
  ['Big Hero 6', 'Don Hall and Chris Williams (directors)', 'animation_games', 'movie', 'Movies', ['character expression', 'assistant behavior', 'fiction']],
  ['The Martian', 'Ridley Scott (director)', 'reasoning_fact_checking', 'movie', 'Movies', ['problem-solving', 'troubleshooting', 'fiction']],
  ['Spider-Man: Into the Spider-Verse', 'Bob Persichetti, Peter Ramsey and Rodney Rothman (directors)', 'animation_games', 'movie', 'Movies', ['stylized animation', 'visual storytelling', 'fiction']],
  ['Inside Out', 'Pete Docter (director)', 'psychology_emotion', 'movie', 'Movies', ['emotion', 'human behavior', 'fiction']],
  ['Minority Report', 'Steven Spielberg (director)', 'communication_accessibility', 'movie', 'Movies', ['interface concepts', 'fiction']],
  ['Ex Machina', 'Alex Garland (director)', 'ai_agents', 'movie', 'Movies', ['ai behavior', 'trust', 'deception', 'fiction']],
  ['Arrival', 'Denis Villeneuve (director)', 'natural_language_speech', 'movie', 'Movies', ['language', 'interpretation', 'communication', 'fiction']],
  ['WALL-E', 'Andrew Stanton (director)', 'animation_games', 'movie', 'Movies', ['nonverbal communication', 'robotics', 'fiction']],
  ['The Social Network', 'David Fincher (director)', 'business_management', 'movie', 'Movies', ['startup storytelling', 'teamwork', 'fiction']],
  ['The Imitation Game', 'Morten Tyldum (director)', 'math_statistics', 'movie', 'Movies', ['computing history', 'problem-solving', 'fiction']],
  ['Interstellar', 'Christopher Nolan (director)', 'math_statistics', 'movie', 'Movies', ['scientific themes', 'teamwork', 'fiction']],
  ['Hidden Figures', 'Theodore Melfi (director)', 'math_statistics', 'movie', 'Movies', ['mathematics', 'engineering', 'collaboration', 'fiction']],

  // 68–77: technical documentation and research collections
  ['Flutter and Dart documentation', 'Flutter team (Google)', 'software_engineering', DOC, 'Technical documentation', ['flutter', 'dart', 'mobile apps'], 'https://docs.flutter.dev'],
  ['Cloudflare Workers documentation', 'Cloudflare', 'software_engineering', DOC, 'Technical documentation', ['workers', 'durable objects', 'serverless'], 'https://developers.cloudflare.com/workers/'],
  ['GitHub documentation', 'GitHub', 'software_engineering', DOC, 'Technical documentation', ['github', 'actions', 'pull requests'], 'https://docs.github.com'],
  ['Apple Developer documentation', 'Apple', 'software_engineering', DOC, 'Technical documentation', ['ios', 'swift', 'apple platforms'], 'https://developer.apple.com/documentation/'],
  ['Python documentation', 'Python Software Foundation', 'software_engineering', DOC, 'Technical documentation', ['python', 'standard library'], 'https://docs.python.org/3/'],
  ['MDN Web Docs', 'Mozilla', 'software_engineering', DOC, 'Technical documentation', ['javascript', 'web', 'html', 'css'], 'https://developer.mozilla.org/'],
  ['OWASP security standards', 'OWASP Foundation', 'cybersecurity', DOC, 'Technical documentation', ['owasp', 'web security', 'standards'], 'https://owasp.org/'],
  ['Stanford Introduction to Information Retrieval', 'Stanford NLP Group', 'search_rag', BOOK, 'Research collections', ['information retrieval', 'indexing', 'ranking'], 'https://www-nlp.stanford.edu/IR-book/'],
  ['Google SRE Books', 'Google', 'debugging_reliability', DOC, 'Research collections', ['sre', 'reliability', 'incidents'], 'https://sre.google/books/'],
  ['arXiv research papers', 'arXiv (Cornell University)', 'search_rag', PAPER, 'Research collections', ['research papers', 'preprints'], 'https://arxiv.org/'],
]);

/** Catalogs every seed entry. Repeating it adds nothing: a reference already in the library is returned as a duplicate. */
export function seedKnowledgeCatalog(kl, { now } = {}) {
  const out = { added: 0, duplicates: 0, errors: [] };
  for (const [title, creator, category, kind, subcategory, topics, source_url = '', note = ''] of KNOWLEDGE_CATALOG_SEED) {
    const result = kl.catalog({
      title, creator, category, kind, subcategory, topics, source_url,
      license: 'unknown',
      note: note || (kind === 'movie' ? 'Fiction: inspiration for design and narrative, not evidence of real technology.' : kind === 'comic' ? 'Comic: inspiration for storytelling and design. Text not stored.' : ''),
    }, now ? { now } : {});
    if (result.error) out.errors.push(`${title}: ${result.error}`);
    else if (result.duplicate) out.duplicates += 1;
    else out.added += 1;
  }
  return out;
}

export { KnowledgeLibrary };
