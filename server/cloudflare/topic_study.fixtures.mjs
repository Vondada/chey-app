// Shared fixtures for topic-study tests: the owner's real prompt and a
// README shaped like codecrafters-io/build-your-own-x.
// The exact prompt the owner gives CHE for build-your-own-x.
export const OWNER_PROMPT = `CHE, study codecrafters-io/build-your-own-x on GitHub (the Build your own X README) and implement what you learn into your own code, one topic at a time:
1. Search Engine and Database: use them to make the Brain room's memory search faster and better at finding related memories.
2. Bot: use it to help your Office agents keep track of their work and choose their next step better.
3. Neural Network and Visual Recognition System: learn how speech and image recognition work inside, and use that to improve how you handle my voice and my pictures.
4. Git: use it to make your self-update and pull request work safer.
5. When those are done, tell me which other topic in that README would fix your weakest area and why, but do not start it until I say go.
For each topic, read its tutorials, compare them with your real code, and only change what truly makes you better. That repo has no license, so learn the ideas and write your own code; never copy theirs. Tell me honestly what you read, what you learned and what you changed. Every change comes to me for approval before any pull request is merged.`;

export const README = [
  '<h1 align="center">Build your own &lt;insert-technology-here&gt;</h1>',
  '## Table of Contents',
  '* [3D Renderer](#build-your-own-3d-renderer)',
  '* [Bot](#build-your-own-bot)',
  '## Tutorials',
  '#### Build your own `3D Renderer`',
  '* [**C++**: _Introduction to Ray Tracing_](https://www.scratchapixel.com/ray-tracing)',
  '#### Build your own `Bot`',
  '* [**Haskell**: _Roll your own IRC bot_](https://wiki.haskell.org/Roll_your_own_IRC_bot)',
  '* [**Node.js**: _Creating a Simple Facebook Messenger AI Bot_](https://tutorials.example.com/messenger-bot)',
  '* [**Python**: _How to Build Your First Slack Bot with Python_](https://www.fullstackpython.com/blog/build-first-slack-bot-python.html)',
  '* [**JavaScript**: _Build a bot live_](https://www.youtube.com/watch?v=abc) `[video]`',
  '#### Build your own `Database`',
  '* [**C**: _Let\'s Build a Simple Database_](https://cstack.github.io/db_tutorial/)',
  '* [**Go**: _Build Your Own Database from Scratch_](https://build-your-own.org/database/)',
  '#### Build your own `Front-end Framework / Library`',
  '* [**JavaScript**: _WTF is JSX_](https://jasonformat.com/wtf-is-jsx/)',
  '#### Build your own `Git`',
  '* [**JavaScript**: _Gitlet_](http://gitlet.maryrosecook.com/docs/gitlet.html)',
  '* [**Python**: _Write yourself a Git!_](https://wyag.thb.lt/)',
  '#### Build your own `Memory Allocator`',
  '* [**C**: _Memory Allocators 101_](https://arjunsreedharan.org/post/148675821737/memory-allocators-101-write-a-simple-memory)',
  '#### Build your own `Neural Network`',
  '* [**Python**: _A Neural Network in 11 lines of Python_](https://iamtrask.github.io/2015/07/12/basic-python-network/)',
  '* [**JavaScript**: _Neural networks from scratch_](https://github.com/example/nn-from-scratch)',
  '#### Build your own `Search Engine`',
  '* [**CSS**: _A search engine in CSS_](https://stories.algolia.com/a-search-engine-in-css-b5ec4e902e97)',
  '* [**Python**: _Building a search engine using Redis and redis-py_](http://www.dr-josiah.com/2010/07/building-search-engine-using-redis-and.html)',
  '* [**Python**: _Building a Vector Space Indexing Engine in Python_](https://boyter.org/2010/08/build-vector-space-search-engine-python/)',
  '* [**JavaScript**: _Search engine in JS_](https://example.dev/js-search)',
  '#### Build your own `Visual Recognition System`',
  '* [**Python**: _Developing a License Plate Recognition System with Machine Learning in Python_](https://blog.example.com/plates)',
  '#### Build your own `Web Server`',
  '* [**C#**: _Writing a Web Server from Scratch_](https://www.codeproject.com/web-server)',
  '## Uncategorized',
  '* [**Go**: _Build a URL shortener_](https://example.com/shortener)',
  '## Contribute',
  '* Submissions welcome, just [open a PR](https://github.com/codecrafters-io/build-your-own-x/pulls)',
  '## License',
  '[![CC0](https://licensebuttons.net/p/zero/1.0/88x31.png)](https://creativecommons.org/publicdomain/zero/1.0/)',
].join('\n');
