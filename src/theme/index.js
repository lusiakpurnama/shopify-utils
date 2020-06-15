const _ = require('lodash');
const fs = require('fs');

const FOLDER_THEME = ['config', 'layout', 'locales', 'sections', 'snippets', 'templates', 'templates/customers'];
const FOLDER_TO_CHECK = ['layout', 'sections', 'snippets', 'templates', 'templates/customers'];
const REGEXP_JS = /(.js|.js.liquid)$/g;
const REGEXP_CSS = /(.css|.css.liquid|.scss|.scss.liquid)$/g;
const REGEXP_LIQUID_TAG = /{%.*?%}/g;
const REGEXP_QUOTED = /(?<=['"`]).*?(?=['"`])/;
const REGEXP_COMMENT = /{%[\s-]{0,3}comment[^]*?endcomment[\s-]{0,3}%}/g;
const REGEXP_SCHEMA = /{%[\s-]{0,3}schema[^]*?endschema[\s-]{0,3}%}/g;
const REGEXP_SCHEMA_JSON = /(?<={%[\s-]{0,3}schema[\s-]{0,3}%})[^]*?(?={%[\s-]{0,3}endschema[\s-]{0,3}%})/g;

class ShopifyTheme {
	constructor(pathToTheme) {
		this.pathToTheme = pathToTheme;
		this.files = {};
		this.filenames = {};
		this.themeStats = {
			folder: {},
			totalFiles: 0,
		};
		this.assets = { js: [], css: [], other: [] };
		this.snippets = { used: [], unused: [], loopCall: [] };
		this.sections = { used: [], unused: [], preset: [] };

		this.readThemeFiles();
		this.processSections();
	}

	readThemeFiles() {
		this.readAssetFiles();
		_.forEach(FOLDER_THEME, (folder) => {
			const path = `${this.pathToTheme}/${folder}`;
			const filenames = fs.readdirSync(path);
			this.files[folder] = {};
			this.filenames[folder] = filenames;
			if (folder === 'templates') _.remove(filenames, (n) => n === 'customers');

			this.themeStats.folder[folder] = filenames.length;
			this.themeStats.totalFiles += filenames.length;

			_.forEach(filenames, (filename) => {
				let content = fs.readFileSync(`${path}/${filename}`, { encoding: 'utf-8' });
				content = _.replace(content, REGEXP_COMMENT, '');
				this.files[folder][filename] = { content };
			});
		});
	}

	readAssetFiles() {
		const path = `${this.pathToTheme}/assets`;
		this.filenames.assets = fs.readdirSync(path);
		this.themeStats.folder.assets = this.filenames.assets.length;
		this.themeStats.totalFiles += this.filenames.assets.length;
		this.assets.js = _.filter(this.filenames.assets, (n) => n.match(REGEXP_JS));
		this.assets.css = _.filter(this.filenames.assets, (n) => n.match(REGEXP_CSS));
		this.assets.other = _.filter(this.filenames.assets, (n) => !n.match(REGEXP_JS) && !n.match(REGEXP_CSS));
	}

	processSections() {
		_.forEach(this.filenames.sections, (file) => {
			const { content } = this.files.sections[file];
			if (!content) return;
			const json = content.match(REGEXP_SCHEMA_JSON);
			this.files.sections[file].content = _.replace(content, REGEXP_SCHEMA, '');
			if (!_.isEmpty(json)) {
				const schema = JSON.parse(json);
				this.files.sections[file].schema = schema;
				if (!_.isEmpty(schema.presets)) {
					this.sections.preset.push(file);
				}
			}
		});
	}

	getLiquidTags(content) {
		const liquidTag = content.match(REGEXP_LIQUID_TAG);
		return _.map(liquidTag, (tag) => {
			const start = _.startsWith(tag, '{%-') ? 3 : 2;
			const end = _.endsWith(tag, '-%}') ? -3 : -2;
			let split = _.slice(tag, start, end).join('');
			split = _.trim(split);
			split = _.split(split, /[\s,;]+/);
			return { tag, type: split[0], split };
		});
	}

	processLiquidFile(folder, file) {
		const { content } = this.files[folder][file];
		const liquidTag = this.getLiquidTags(content);
		this.files[folder][file].liquidTag = _.map(liquidTag, (tag) => {
			const result = { ...tag };
			if (tag.split.length === 1) return result;
			const firstVar = tag.split[1];
			const filename = `${(firstVar.match(REGEXP_QUOTED) || [''])[0]}.liquid`;
			if (tag.type === 'include' || tag.type === 'render') {
				if (folder === 'snippets' && filename === file) {
					this.snippets.loopCall.push(filename);
					result.filename = filename;
				} else if (!_.includes(this.filenames.snippets, filename)) {
					this.includesNotFile.push(tag.tag);
				} else {
					if (!_.includes(this.snippets.used, filename)) this.snippets.used.push(filename);
					result.filename = filename;
				}
			} else if (tag.type === 'section') {
				if (!_.includes(this.filenames.sections, filename)) {
					this.sectionsNotFile.push(tag.tag);
				} else {
					if (!_.includes(this.sections.used, filename)) this.sections.used.push(filename);
					result.filename = filename;
				}
			}
			return result;
		});
	}

	checkIncludesAndSections() {
		this.includesNotFile = [];
		this.sectionsNotFile = [];
		_.forEach(FOLDER_TO_CHECK, (folder) => {
			_.forEach(this.filenames[folder], (file) => {
				this.processLiquidFile(folder, file);
			});
		});
		this.includesNotFile = _.uniq(this.includesNotFile);
		this.sectionsNotFile = _.uniq(this.sectionsNotFile);
		this.snippets.unused = _.without(this.filenames.snippets, ...this.snippets.used);
		this.sections.unused = _.without(this.filenames.sections, ...this.sections.used, ...this.sections.preset);
	}

	checkAssetFiles() {
		this.assets.used = { js: [], css: [], other: [] };
		this.assets.unused = { js: [], css: [], other: [] };
		_.forEach(['js', 'css', 'other'], (type) => {
			_.forEach(this.assets[type], (asset) => {
				const filename = _.replace(asset, /.liquid$/, '');
				let used = false;
				_.forEach(FOLDER_TO_CHECK, (folder) => {
					_.forEach(this.filenames[folder], (file) => {
						used = _.includes(this.files[folder][file].content, filename);
						return !used;
					});
					return !used;
				});
				if (used) {
					this.assets.used[type].push(asset);
				} else { this.assets.unused[type].push(asset); }
			});
		});
	}

	compileFile(folder, file) {
		const fileDetail = this.files[folder][file];
		if (_.isEmpty(fileDetail)) { return { compiled: `<!-- file not exist: ${folder}/${file} -->` }; }
		const { content } = fileDetail;
		if (!_.isEmpty(fileDetail.compiled)) { return fileDetail; }
		if (_.isEmpty(fileDetail.liquidTag)) { this.processLiquidFile(folder, file); }
		const { liquidTag } = fileDetail;
		let result = content;
		let totSnippets = 0;
		let totSections = 0;
		_.forEach(_.filter(liquidTag, (t) => _.includes(['include', 'render', 'section'], t.type)), (t) => {
			const f = t.type === 'section' ? 'sections' : 'snippets';
			if (folder === 'snippets' && folder === f && file === t.filename) {
				result = _.replace(result, t.tag, '<!-- loop include -->');
			} else {
				const { compiled, totalSnippets, totalSections } = this.compileFile(f, t.filename);
				result = _.replace(result, t.tag, compiled);
				totSnippets += totalSnippets || 0;
				totSections += totalSections || 0;
			}
			if (f === 'snippets') totSnippets += 1;
			if (f === 'sections') totSections += 1;
		});
		fileDetail.compiled = result;
		fileDetail.totalSnippets = totSnippets;
		fileDetail.totalSections = totSections;
		return fileDetail;
	}

	analyzeFile(folder, file) {
		const { compiled, totalSnippets, totalSections } = this.compileFile(folder, file);
		const { totalFor, maxFor, minFor } = this.analyzeForLoop(compiled);

		return {
			compiled, totalFor, maxFor, minFor, totalSnippets, totalSections,
		};
	}

	analyzeForLoop(content) {
		const liquidTag = this.getLiquidTags(content, true);
		const ifTag = ['if', 'unless', 'case'];
		const endIfTag = ['endif', 'endunless', 'endcase'];
		const totalIf = _.filter(liquidTag, (tag) => _.includes(ifTag, tag.type)).length;
		const totalEndIf = _.filter(liquidTag, (tag) => _.includes(endIfTag, tag.type)).length;
		const totalFor = _.filter(liquidTag, (tag) => tag.type === 'for').length;
		console.log('Analyzing for loops');
		console.log('total If:', totalIf);
		console.log('total EndIf:', totalEndIf);
		console.log('total For:', totalFor);
		if (totalIf !== totalEndIf) {
			console.log('Number of if / unless / case not equal to number of endif / endunless / endcase');
			console.log('Please check if your code have {% comment %} inside {% comment %}, this may cause the comment not removed correctly.');
			return { totalFor, maxFor: 0, minFor: 0 };
		}

		let maxFor = 0;
		let minFor = 0;
		const ifBlock = [];
		const stack = [];
		let currentIf = null;
		// let level = 0;
		_.forEach(liquidTag, (tag, index) => {
			if (_.includes(['if', 'unless', 'case'], tag.type)) {
				// console.log(`${_.padStart('', level * 2)}${tag.tag}`);
				if (!_.isEmpty(currentIf)) { stack.push(currentIf); }
				// level += 1;
				currentIf = {
					index: [index], forCount: 0, maxFor: 0, minFor: null,
				};
			} else if (_.includes(['elsif', 'else', 'when'], tag.type)) {
				// console.log('else', currentIf);
				currentIf.index.push(index);
				if (currentIf.maxFor < currentIf.forCount) currentIf.maxFor = currentIf.forCount;
				if (currentIf.minFor === null || currentIf.minFor > currentIf.forCount) currentIf.minFor = currentIf.forCount;
				currentIf.forCount = 0;
			} else if (_.includes(['endif', 'endunless', 'endcase'], tag.type)) {
				// level -= 1;
				// console.log(`${_.padStart('', level * 2)}${tag.tag}`);
				currentIf.index.push(index);
				if (currentIf.maxFor < currentIf.forCount) currentIf.maxFor = currentIf.forCount;
				if (currentIf.minFor === null || currentIf.minFor > currentIf.forCount) currentIf.minFor = currentIf.forCount;
				currentIf.forCount = 0;
				if (!_.isEmpty(stack)) {
					const parentIf = stack.pop();
					parentIf.index.push(currentIf.index);
					parentIf.childMaxFor = currentIf.maxFor + (currentIf.childMaxFor || 0);
					parentIf.childMinFor = currentIf.minFor + (currentIf.childMinFor || 0);
					currentIf = parentIf;
				} else {
					// console.log();
					ifBlock.push(currentIf);
					// console.log(liquidTag[_.first(currentIf.index)].tag);
					// console.log(liquidTag[_.last(currentIf.index)].tag);
					maxFor += currentIf.maxFor + (currentIf.childMaxFor || 0);
					minFor += currentIf.minFor + (currentIf.childMinFor || 0);
					currentIf = null;
				}
			} else if (tag.type === 'for') {
				if (_.isEmpty(currentIf)) {
					maxFor += 1;
					minFor += 1;
				} else {
					currentIf.forCount += 1;
				}
			} else {
				// console.log(`${_.padStart('', level * 2)}${tag.tag}`);
			}
		});
		return { totalFor, maxFor, minFor };
	}
}

module.exports = ShopifyTheme;