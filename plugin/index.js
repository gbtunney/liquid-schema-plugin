const fs = require('fs-extra');
const path = require('path');
const validate = require('schema-utils');
const { RawSource } = require('webpack-sources');
const { asString } = require('webpack').Template;
const glob = require('glob');
const optionsSchema = require('./schema');

const PLUGIN_NAME = 'Liquid Schema Plugin';

module.exports = class LiquidSchemaPlugin {
    constructor(options = {}) {
        validate(optionsSchema, options, { name: PLUGIN_NAME });
        this.options = options;
    }

    apply(compiler) {
        const isWebpack4 = !compiler.webpack;

        if (isWebpack4) {
            compiler.hooks.emit.tapPromise(
                PLUGIN_NAME,
                this.buildSchema.bind(this)
            );

            return;
        }

        compiler.hooks.thisCompilation.tap(PLUGIN_NAME, compilation => {
            compilation.hooks.processAssets.tapPromise(
                PLUGIN_NAME,
                this.buildSchema.bind(this, compilation)
            );
        });
    }

    async buildSchema(compilation) {
        const files = this.getFileArr(this.options.from.liquid); // await fs.readdir(this.options.from.liquid);

        const compilationOutput = compilation.compiler.outputPath;

        compilation.contextDependencies.add(this.options.from.liquid);
        compilation.contextDependencies.add(this.options.from.schema);

        const preTransformCache = [...Object.keys(require.cache)];

        return Promise.all(
            files.map(async file => {
                const fileLocation = path.resolve(file);
                const fileStat = await fs.stat(fileLocation);

                if (fileStat.isFile() && path.extname(file) === '.liquid') {
                    const relativeFilePath = path.relative(
                        compilation.options.context,
                        fileLocation
                    );

                    const outputKey = this.getOutputKey(
                        path.basename(fileLocation),
                        compilationOutput
                    );
                    try {
                        // eslint-disable-next-line no-param-reassign
                        compilation.assets[
                            outputKey
                        ] = await this.replaceSchemaTags(
                            fileLocation,
                            compilation
                        );
                    } catch (error) {
                        compilation.errors.push(
                            new Error(`./${relativeFilePath}\n\n${error}`)
                        );
                    }
                }
            })
        ).then(() => {
            const postTransformCache = [...Object.keys(require.cache)];
            postTransformCache
                .filter(module => !preTransformCache.includes(module))
                .forEach(module => {
                    compilation.contextDependencies.add(path.dirname(module));
                    compilation.fileDependencies.add(module);
                    delete require.cache[module];
                });
        });
    }

    getOutputKey(liquidSourcePath, compilationOutput) {
        const fileName = liquidSourcePath; /* path.relative(
            this.options.from.liquid,
            liquidSourcePath
        ); */
        const relativeOutputPath = path.relative(
            compilationOutput,
            this.options.to
        );

        return path.join(relativeOutputPath, fileName);
    }

    getFileArr(_globpath) {
        return glob.sync(_globpath).map(function (_path) {
            return _path;
        });
    }

    async replaceSchemaTags(fileLocation, compilation) {
        const fileName = path.basename(fileLocation, '.liquid');
        const fileContents = await fs.readFile(fileLocation, 'utf-8');
        const replaceableSchemaRegex = /{%-?\s*schema\s*('.*'|".*")\s*-?%}(([\s\S]*){%-?\s*endschema\s*-?%})?/;
        const fileContainsReplaceableSchemaRegex = replaceableSchemaRegex.test(
            fileContents
        );

        if (!fileContainsReplaceableSchemaRegex) {
            return new RawSource(fileContents);
        }

        // eslint-disable-next-line prefer-const
        let [match, importableFilePath, , contents] = fileContents.match(
            replaceableSchemaRegex
        );
        importableFilePath = importableFilePath.replace(
            /(^('|"))|(('|")$)/g,
            ''
        );
        importableFilePath = path.resolve(
            path.dirname(fileLocation),
            // this.options.from.schema,
            importableFilePath
        );
        compilation.fileDependencies.add(require.resolve(importableFilePath));

        let importedSchema;
        try {
            // eslint-disable-next-line global-require, import/no-dynamic-require
            importedSchema = require(importableFilePath);
        } catch (error) {
            throw [
                match,
                '^',
                `      File to import not found or unreadable: ${importableFilePath}`,
                `      in ${fileLocation}`,
            ].join('\n');
        }

        try {
            contents = JSON.parse(contents);
        } catch (error) {
            contents = null;
        }

        let schema = importedSchema;
        if (typeof importedSchema === 'function') {
            schema = importedSchema(fileName, contents);
        }

        if (typeof schema !== 'object') {
            throw [
                schema,
                '^',
                `      Schema expected to be of type "object"`,
                `      in ${require.resolve(importableFilePath)}`,
            ].join('\n');
        }

        return new RawSource(
            fileContents.replace(
                replaceableSchemaRegex,
                asString([
                    '{% schema %}',
                    JSON.stringify(schema, null, 4),
                    '{% endschema %}',
                ])
            )
        );
    }
};
