#!/usr/bin/env node
// Stand-in for `zeditor`: records the "<path>:<line>" it was asked to open.
import fs from 'node:fs';

fs.appendFileSync(process.env.OPEN_LOG, `${process.argv[2]}\n`);
