import cloneDeep from 'lodash/cloneDeep';
import isEmpty from 'lodash/isEmpty';
import omit from 'lodash/omit';
import pick from 'lodash/pick';
import { extract, toArray } from '../../../libs/arrays';
import { ObjectBuilder } from '../../../libs/objects';
import { getModel, getModelAttributes, isComponentAttribute, isDynamicZoneAttribute, isMediaAttribute, isRelationAttribute } from '../../utils/models';
import { SchemaUID } from '@strapi/strapi/lib/types/utils';
import { Entry, EntryId, Schema, User, Attribute } from '../../types';
import { toPairs } from 'lodash';
import { FileEntry, FileEntryDynamicZone, FileId } from './types';
import { findOrImportFile } from './utils/file';

type Import = {
  version: 2;
  data: ImportData;
};
type ImportData = ImportDataSlugEntries;
type ImportDataSlugEntries = {
  [slug in SchemaUID]: SlugEntries;
};
type SlugEntries = Record<FileId, FileEntry>;

type ImportFailures = {
  /** Error raised. */
  error: Error;
  /** Data for which import failed. */
  data: any;
};

class IdMapper {
  private mapping: {
    [slug in SchemaUID]?: Map<string | number, string | number>;
  } = {};

  public getMapping(slug: SchemaUID, fileId: string | number) {
    return this.mapping[slug]?.get(`${fileId}`);
  }

  public setMapping(slug: SchemaUID, fileId: string | number, dbId: string | number) {
    if (!this.mapping[slug]) {
      this.mapping[slug] = new Map<string | number, string | number>();
    }

    this.mapping[slug]!.set(`${fileId}`, dbId);
  }
}

/**
 * Import data.
 * @returns {Promise<ImportDataRes>}
 */
const importDataV2 = async (
  fileContent: Import,
  {
    slug: slugArg,
    user,
    idField,
  }: {
    slug: SchemaUID;
    /** User importing the data. */
    user: User;
    /** Field used as unique identifier. */
    idField: string;
  },
) => {
  const { data } = fileContent;

  const slugs: SchemaUID[] = Object.keys(data) as SchemaUID[];
  let failures: ImportFailures[] = [];
  const fileIdToDbId = new IdMapper();
  const simpleAttributes: Record<string, any> = {};

  const { componentSlugs, mediaSlugs, contentTypeSlugs } = splitSlugs(slugs);
  const componentsDataStore: Partial<Record<SchemaUID, SlugEntries>> = {};
  for (const slug of componentSlugs) {
    componentsDataStore[slug] = data[slug];
  }

  for (const slug of mediaSlugs) {
    const res = await importMedia(data[slug], { user, fileIdToDbId });
    failures.push(...res.failures);
  }

  // Import content types without setting relations.
  for (const slug of contentTypeSlugs) {
    const res = await importContentTypeSlug(data[slug], simpleAttributes, {
      slug: slug,
      user,
      // Keep behavior of `idField` of version 1.
      ...(slug === slugArg ? { idField } : {}),
      importStage: 'simpleAttributes',
      fileIdToDbId,
      componentsDataStore,
    });
    failures.push(...res.failures);
  }

  // Set relations of content types.
  for (const slug of contentTypeSlugs) {
    const res = await importContentTypeSlug(data[slug], simpleAttributes, {
      slug: slug,
      user,
      // Keep behavior of `idField` of version 1.
      ...(slug === slugArg ? { idField } : {}),
      importStage: 'relationAttributes',
      fileIdToDbId,
      componentsDataStore,
    });
    failures.push(...res.failures);
  }

  // Sync primary key sequence for postgres databases.
  // See https://github.com/strapi/strapi/issues/12493.
  // TODO: improve strapi typing
  if ((strapi.db as any).config.connection.client === 'postgres') {
    for (const slugFromFile of slugs) {
      const model = getModel(slugFromFile);
      // TODO: handle case when `id` is not a number;
      await strapi.db.connection.raw(`SELECT SETVAL((SELECT PG_GET_SERIAL_SEQUENCE('${model.collectionName}', 'id')), (SELECT MAX(id) FROM ${model.collectionName}) + 1, FALSE);`);
    }
  }

  return { failures };
};

function splitSlugs(slugs: SchemaUID[]) {
  const slugsToProcess = [...slugs];
  const componentSlugs = extract(slugsToProcess, (slug) => getModel(slug)?.modelType === 'component');
  const mediaSlugs = extract(slugsToProcess, (slug) => ['plugin::upload.file'].includes(slug));
  const contentTypeSlugs = extract(slugsToProcess, (slug) => getModel(slug)?.modelType === 'contentType');

  if (slugsToProcess.length > 0) {
    strapi.log.warn(`Some slugs won't be imported: ${slugsToProcess.join(', ')}`);
  }

  return {
    componentSlugs,
    mediaSlugs,
    contentTypeSlugs,
  };
}

const importMedia = async (slugEntries: SlugEntries, { user, fileIdToDbId }: { user: User; fileIdToDbId: IdMapper }): Promise<{ failures: ImportFailures[] }> => {
  const failures: ImportFailures[] = [];

  const fileEntries = toPairs(slugEntries);

  for (let [fileId, fileEntry] of fileEntries) {
    try {
      const dbEntry = await findOrImportFile(fileEntry, user, { allowedFileTypes: ['any'] });
      if (dbEntry) {
        fileIdToDbId.setMapping('plugin::upload.file', fileId, dbEntry?.id);
      }
    } catch (err: any) {
      strapi.log.error(err);
      failures.push({ error: err, data: fileEntry });
    }
  }

  return {
    failures,
  };
};

type ImportStage = 'simpleAttributes' | 'relationAttributes';

const importContentTypeSlug = async (
  slugEntries: SlugEntries, simpleAttributes: Record<string, any>,
  {
    slug,
    user,
    idField,
    importStage,
    fileIdToDbId,
    componentsDataStore,
  }: { slug: SchemaUID; user: User; idField?: string; importStage: ImportStage; fileIdToDbId: IdMapper; componentsDataStore: Partial<Record<SchemaUID, SlugEntries>> },
): Promise<{ failures: ImportFailures[] }> => {
  let fileEntries = toPairs(slugEntries);

  // Sort localized data with default locale first.
  const sortDataByLocale = async () => {
    const schema = getModel(slug);

    if (schema.pluginOptions?.i18n?.localized) {
      const defaultLocale = await strapi.plugin('i18n').service('locales').getDefaultLocale();
      fileEntries = fileEntries.sort((dataA, dataB) => {
        if (dataA[1].locale === defaultLocale && dataB[1].locale === defaultLocale) {
          return 0;
        } else if (dataA[1].locale === defaultLocale) {
          return -1;
        }
        return 1;
      });
    } else if(slug === 'plugin::upload.folder') {
            fileEntries = fileEntries.sort((dataA, dataB) => {
                const segmentsA = dataA[1]?.path?.toString().split('/') as any as string;
                const segmentsB = dataB[1]?.path?.toString().split('/') as any as string;
                const rootA = typeof segmentsA === 'string' ? segmentsA.length : 0;
                const rootB = typeof segmentsB === 'string' ? segmentsB.length : 0;
                if (rootA < rootB) {
                    return -1;
                } else if (rootA > rootB) {
                    return 1;
                } else {
                    return (dataA[1]?.path?.toString() ?? '').localeCompare(dataB[1]?.path?.toString() ?? '');
                }
            });
        }
  };
  await sortDataByLocale();

  const failures: ImportFailures[] = [];
  for (let [fileId, fileEntry] of fileEntries) {
    try {
      await updateOrCreate(user, slug, fileId, fileEntry, idField, simpleAttributes, { importStage, fileIdToDbId, componentsDataStore });
    } catch (err: any) {
      strapi.log.error(err);
      failures.push({ error: err, data: fileEntry });
    }
  }

  return {
    failures,
  };
};

const updateOrCreate = async (
  user: User,
  slug: SchemaUID,
  fileId: FileId,
  fileEntryArg: FileEntry,
  idFieldArg: string | undefined,
  simpleAttributes: Record<string, any>,
  { importStage, fileIdToDbId, componentsDataStore }: { importStage: ImportStage; fileIdToDbId: IdMapper; componentsDataStore: Partial<Record<SchemaUID, SlugEntries>> },
) => {
  const schema = getModel(slug);
  const idField = idFieldArg || schema?.pluginOptions?.['import-export-entries']?.idField || 'id';

  let fileEntry = cloneDeep(fileEntryArg);
  //var fullAttributes = [];
  let fullAttributes: Record<string, Attribute> = {};

  if (importStage == 'simpleAttributes') {
    fileEntry = removeComponents(schema, fileEntry);
    const attributeNames = getModelAttributes(slug, { filterOutType: ['media', 'relation'] })
      .map(({ name }) => name)
      .concat('id', 'localizations', 'locale');
    fileEntry = pick(fileEntry, attributeNames);

    //this will grow, should be cleaned-up after successful update/create of an item (or generally refactored not to pass this map all over the place)
    simpleAttributes[slug + ":::" + fileId] = fileEntry;

  } else if (importStage === 'relationAttributes') {
    fileEntry = setComponents(schema, fileEntry, { fileIdToDbId, componentsDataStore });
    const attributeNames = getModelAttributes(slug, { filterType: ['component', 'dynamiczone', 'media', 'relation'] })
      .map(({ name }) => name)
      .concat('id', 'localizations', 'locale');

    fullAttributes = getModelAttributes(slug, { filterType: ['component', 'dynamiczone', 'media', 'relation'] })
        .reduce((map: Record<string, Attribute>, obj: Attribute) => {
            map[obj.name] = obj;
            return map;
          }, {});

    fileEntry = pick(fileEntry, attributeNames);

        const jsonObj = simpleAttributes[slug + ":::" + fileId];

        if(typeof jsonObj !== 'undefined') {
            strapi.log.info("      Before null cleanup: " + JSON.stringify(jsonObj));
            const simplAttrsCleaned = Object.keys(jsonObj)
                .filter(key => jsonObj[key] !== null && (!Array.isArray(jsonObj[key]) || jsonObj[key].length>0))
                .reduce((obj, key) => {
                  strapi.log.info("    " + key + "    -  " + JSON.stringify(obj));
                    (obj as any)[key] = jsonObj[key];
                    return obj;
                }, {});
            strapi.log.info("      After null cleanup: " + JSON.stringify(simplAttrsCleaned));
            const mergedObj = Object.assign({}, fileEntry, simplAttrsCleaned);
            fileEntry = mergedObj;
            strapi.log.info("  After merge relationAttributes: " + JSON.stringify(fileEntry));
        }
  }

  let dbEntry: Entry | null = null;
  if (schema?.modelType === 'contentType' && schema?.kind === 'singleType') {
    dbEntry = await updateOrCreateSingleTypeEntry(user, slug, fileId, fileEntry, { importStage, fileIdToDbId }, fullAttributes);
  } else {
    dbEntry = await updateOrCreateCollectionTypeEntry(user, slug, fileId, fileEntry, { idField, importStage, fileIdToDbId }, fullAttributes);
  }
  if (dbEntry) {
    fileIdToDbId.setMapping(slug, fileId, dbEntry.id);

        if(slug === 'plugin::upload.folder' && fileId != dbEntry.id) {
            adjustIds(fileEntry, fullAttributes, fileIdToDbId, slug);

            strapi.entityService.update(slug, dbEntry.id, { data: omit(fileEntry, ['id']) });

            //fix all images under this folder
            if (fileEntry.files !== null && fileEntry.files !== undefined) {
                for(const img of fileEntry.files as number[]) {
                  //strapi.log.info("Fixing image " + img + " from folder " + dbEntry.id);
                  strapi.entityService.update("plugin::upload.file", img, {data: {"folderPath": (dbEntry as any)["path"]}});
                }
            }
        }
  }
};

function removeComponents(schema: Schema, fileEntry: FileEntry) {
  const store: Record<string, any> = {};
  for (const [attributeName, attribute] of Object.entries(schema.attributes)) {
    // Do not reset an attribute component that is not imported.
    if (typeof fileEntry[attributeName] === 'undefined') {
      continue;
    }

    if (isComponentAttribute(attribute)) {
      if (attribute.repeatable) {
        store[attributeName] = [];
      } else {
        store[attributeName] = null;
      }
    } else if (isDynamicZoneAttribute(attribute)) {
      store[attributeName] = [];
    }
  }

  return { ...fileEntry, ...(store || {}) };
}

function setComponents(
  schema: Schema,
  fileEntry: FileEntry,
  { fileIdToDbId, componentsDataStore }: { fileIdToDbId: IdMapper; componentsDataStore: Partial<Record<SchemaUID, SlugEntries>> },
) {
  const store: Record<string, any> = {};
  for (const [attributeName, attribute] of Object.entries(schema.attributes)) {
    //strapi.log.info("setComponents, current: " + attributeName + ", " + JSON.stringify(attribute) + " ------- > " + JSON.stringify(fileEntry));
    
    const attributeValue = fileEntry[attributeName];
    if (attributeValue == null) {
      continue;
    } else if (isComponentAttribute(attribute)) {
      if (attribute.repeatable) {
        store[attributeName] = (attributeValue as (number | string)[]).map((componentFileId) =>
          getComponentData(attribute.component, `${componentFileId}`, { fileIdToDbId, componentsDataStore }),
        );
      } else {
        store[attributeName] = getComponentData(attribute.component, `${attributeValue as number | string}`, { fileIdToDbId, componentsDataStore });
      }
    } else if (isDynamicZoneAttribute(attribute)) {
      store[attributeName] = (attributeValue as FileEntryDynamicZone[]).map(({ __component, id }) => getComponentData(__component, `${id}`, { fileIdToDbId, componentsDataStore }));
    }
  }

  return { ...fileEntry, ...(store || {}) };
}

function getComponentData(
  /** Slug of the component. */
  slug: SchemaUID,
  /** File id of the component. */
  fileId: FileId,
  { fileIdToDbId, componentsDataStore }: { fileIdToDbId: IdMapper; componentsDataStore: Partial<Record<SchemaUID, SlugEntries>> },
): Record<string, any> | null {
  const schema = getModel(slug);
  const fileEntry = componentsDataStore[slug]![`${fileId}`];

  if (fileEntry == null) {
    return null;
  }

  const store: Record<string, any> = { ...omit(fileEntry, ['id']), __component: slug };

  for (const [attributeName, attribute] of Object.entries(schema.attributes)) {
    const attributeValue = fileEntry[attributeName];

    if (attributeValue == null) {
      store[attributeName] = null;
      continue;
    }

    if (isComponentAttribute(attribute)) {
            
      if (attribute.repeatable) {
        store[attributeName] = (attributeValue as (number | string)[]).map((componentFileId) =>
          getComponentData(attribute.component, `${componentFileId}`, { fileIdToDbId, componentsDataStore }),
        );
      } else {
        store[attributeName] = getComponentData(attribute.component, `${attributeValue as number | string}`, { fileIdToDbId, componentsDataStore });
      }
    } else if (isDynamicZoneAttribute(attribute)) {   
      store[attributeName] = (attributeValue as FileEntryDynamicZone[]).map(({ __component, id }) => getComponentData(__component, `${id}`, { fileIdToDbId, componentsDataStore }));
    } else if (isMediaAttribute(attribute)) {
      if (attribute.multiple) {
        store[attributeName] = (attributeValue as (number | string)[]).map((id) => fileIdToDbId.getMapping('plugin::upload.file', id));
      } else {
        store[attributeName] = fileIdToDbId.getMapping('plugin::upload.file', attributeValue as number | string);
      }
    } else if (isRelationAttribute(attribute)) {
      if (attribute.relation.endsWith('Many')) {
        store[attributeName] = (attributeValue as (number | string)[]).map((id) => fileIdToDbId.getMapping(attribute.target, id));
      } else {
        store[attributeName] = fileIdToDbId.getMapping(attribute.target, attributeValue as number | string);
      }
    }
  }

  return store;
}

const updateOrCreateCollectionTypeEntry = async (
  user: User,
  slug: SchemaUID,
  fileId: FileId,
  fileEntry: FileEntry,
  { idField, importStage, fileIdToDbId }: { idField: string; importStage: ImportStage; fileIdToDbId: IdMapper },
  attributes: Record<string, Attribute>
): Promise<Entry | null> => {
  const schema = getModel(slug);

  const whereBuilder = new ObjectBuilder();
  if (fileIdToDbId.getMapping(slug, fileId)) {
    whereBuilder.extend({ id: fileIdToDbId.getMapping(slug, fileId) });
  } else if (fileEntry[idField]) {
    whereBuilder.extend({ [idField]: fileEntry[idField] });
  }
  const where = whereBuilder.get();

  if (!schema.pluginOptions?.i18n?.localized) {
    let dbEntry: Entry = await strapi.db.query(slug).findOne({ where });

    if(dbEntry) {
      fileIdToDbId.setMapping(slug, fileId, dbEntry.id);
    }
    adjustIds(fileEntry, attributes, fileIdToDbId, slug);

    if (!dbEntry) {
      return strapi.entityService.create(slug, { data: fileEntry });
    } else {
      return strapi.entityService.update(slug, dbEntry.id, { data: omit(fileEntry, ['id']) });
    }
  } else {
    if (!fileEntry.locale) {
      throw new Error(`No locale set to import entry for slug ${slug} (data ${JSON.stringify(fileEntry)})`);
    }

    const defaultLocale = await strapi.plugin('i18n').service('locales').getDefaultLocale();
    const isDatumInDefaultLocale = fileEntry.locale === defaultLocale;

    let dbEntryDefaultLocaleId: EntryId | null = null;
    let dbEntry: Entry | null = await strapi.db.query(slug).findOne({ where, populate: ['localizations'] });
    if (isDatumInDefaultLocale) {
      dbEntryDefaultLocaleId = dbEntry?.id || null;
    } else {
      if (dbEntry) {
        // If `dbEntry` has been found, `dbEntry` holds the data for the default locale and
        // the data for other locales in its `localizations` attribute.
        const localizedEntries = [dbEntry, ...(dbEntry?.localizations || [])];
        dbEntryDefaultLocaleId = localizedEntries.find((e: Entry) => e.locale === defaultLocale)?.id || null;
        dbEntry = localizedEntries.find((e: Entry) => e.locale === fileEntry.locale) || null;
      } else {
        // Otherwise try to find dbEntry for default locale through localized siblings.
        let idx = 0;
        const fileLocalizationsIds = (fileEntry?.localizations as EntryId[]) || [];
        while (idx < fileLocalizationsIds.length && !dbEntryDefaultLocaleId && !dbEntry) {
          const dbId = fileIdToDbId.getMapping(slug, fileLocalizationsIds[idx]);
          const localizedEntry: Entry = await strapi.db.query(slug).findOne({ where: { id: dbId }, populate: ['localizations'] });
          const localizedEntries = localizedEntry != null ? [localizedEntry, ...(localizedEntry?.localizations || [])] : [];
          if (!dbEntryDefaultLocaleId) {
            dbEntryDefaultLocaleId = localizedEntries.find((e: Entry) => e.locale === defaultLocale)?.id || null;
          }
          if (!dbEntry) {
            dbEntry = localizedEntries.find((e: Entry) => e.locale === fileEntry.locale) || null;
          }
          idx += 1;
        }
      }
    }

    fileEntry = omit(fileEntry, ['localizations']);
    if (isEmpty(omit(fileEntry, ['id']))) {
      return null;
    }

    if (isDatumInDefaultLocale) {
      adjustIds(fileEntry, attributes, fileIdToDbId, slug);
      if (!dbEntryDefaultLocaleId) {
        return strapi.entityService.create(slug, { data: fileEntry });
      } else {
        if(dbEntry) {
          strapi.log.warn("existing: " + dbEntry.id);
        }
        return strapi.entityService.update(slug, dbEntryDefaultLocaleId, { data: omit({ ...fileEntry }, ['id']) });
      }
    } else {
      if (!dbEntryDefaultLocaleId) {
        throw new Error(`Could not find default locale entry to import localization for slug ${slug} (data ${JSON.stringify(fileEntry)})`);
      }

      if (!dbEntry) {
        const insertLocalizedEntry = strapi.plugin('i18n').service('core-api').createCreateLocalizationHandler(getModel(slug));
        return insertLocalizedEntry({ id: dbEntryDefaultLocaleId, data: omit({ ...fileEntry }, ['id']) });
      } else {
        return strapi.entityService.update(slug, dbEntry.id, { data: omit({ ...fileEntry }, ['id']) });
      }
    }
  }
};

const updateOrCreateSingleTypeEntry = async (
  user: User,
  slug: SchemaUID,
  fileId: FileId,
  fileEntry: FileEntry,
  { importStage, fileIdToDbId }: { importStage: ImportStage; fileIdToDbId: IdMapper },
  attributes: Record<string, Attribute>
): Promise<Entry | null> => {
  const schema = getModel(slug);

  if (!schema.pluginOptions?.i18n?.localized) {
    let dbEntry: Entry = await strapi.db
      .query(slug)
      .findMany({})
      .then((entries) => toArray(entries)?.[0]);

    adjustIds(fileEntry, attributes, fileIdToDbId, slug);

    if (!dbEntry) {
      return strapi.entityService.create(slug, { data: fileEntry });
    } else {
      return strapi.entityService.update(slug, dbEntry.id, { data: omit(fileEntry, ['id']) });
    }
  } else {
    const defaultLocale = await strapi.plugin('i18n').service('locales').getDefaultLocale();
    const isDatumInDefaultLocale = !fileEntry.locale || fileEntry.locale === defaultLocale;

    fileEntry = omit(fileEntry, ['localizations']);
    if (isEmpty(omit(fileEntry, ['id']))) {
      return null;
    }

    adjustIds(fileEntry, attributes, fileIdToDbId, slug);

    let entryDefaultLocale = await strapi.db.query(slug).findOne({ where: { locale: defaultLocale } });
    if (!entryDefaultLocale) {
      entryDefaultLocale = await strapi.entityService.create(slug, { data: { ...fileEntry, locale: defaultLocale } });
    }

    if (isDatumInDefaultLocale) {
      if (!entryDefaultLocale) {
        return strapi.entityService.create(slug, { data: fileEntry });
      } else {
        return strapi.entityService.update(slug, entryDefaultLocale.id, { data: fileEntry });
      }
    } else {
      const entryLocale = await strapi.db.query(slug).findOne({ where: { locale: fileEntry.locale } });
      let datumLocale = { ...entryLocale, ...fileEntry };

      await strapi.db.query(slug).delete({ where: { locale: fileEntry.locale } });

      const insertLocalizedEntry = strapi.plugin('i18n').service('core-api').createCreateLocalizationHandler(getModel(slug));
      return insertLocalizedEntry({ id: entryDefaultLocale.id, data: datumLocale });
    }
  }
};

module.exports = {
  importDataV2,
};
function replaceIdentifier(slug: SchemaUID, splitBy: string, inputStr: string, fileIdToDbId: IdMapper) {
    // Split the string by '/'
    const segments = inputStr.split(splitBy);

    // Map each segment to a different value (e.g., reverse each segment)
    const mappedSegments = segments.map((segment) => {
        var mapped = fileIdToDbId.getMapping(slug, segment);
        return typeof mapped === 'undefined' ? segment : mapped;
      });

    // Join the mapped segments back together using '/'
    let outputStr = mappedSegments.join(splitBy);

    if (!outputStr.startsWith(splitBy)) {
        outputStr = splitBy + outputStr;
    }
    return outputStr;
}
function adjustIds(fileEntry: FileEntry, attributes: Record<string, Attribute>, fileIdToDbId: IdMapper, slug: SchemaUID) {
    strapi.log.info("adjustIds: " + slug + " -> " + JSON.stringify(fileEntry));
    const keys = Object.keys(fileEntry);
    for (const key of keys) { 
        const value = fileEntry[key] as string;
        strapi.log.warn("\t\t" + key + " => " + JSON.stringify(value) + " ( " + (typeof value) + "),,,, " + JSON.stringify(attributes[key]) + " , " + attributes[key] + ", isArray: " + Array.isArray(value) +"  ,,,, " + slug);
        
        if(slug === 'plugin::upload.folder') {
            if(key === 'path') {
                fileEntry[key] = replaceIdentifier(slug, '/', value, fileIdToDbId);
                continue;
            } else if(key === 'pathId') {
                const mapped = fileIdToDbId.getMapping('plugin::upload.folder', value);
                fileEntry[key] = typeof mapped === 'undefined' ? value : mapped;
                continue;
            }
        }
        
        if (typeof attributes[key] === 'undefined') {
            continue;
        }
        if (typeof value === 'number') {
            var mapped;
            if(attributes[key]["type"] === 'media') {
                mapped = fileIdToDbId.getMapping('plugin::upload.file', value);
            } else {
                mapped = fileIdToDbId.getMapping((attributes[key] as any)["target"], value);
            }
            
            if (mapped) {
                fileEntry[key]=mapped;
            }
        } else if (!Array.isArray(value)) {
            //strapi.log.warn(" mapper2: " + JSON.stringify(fileIdToDbId.getMapping(attributes["target"], value)));
        } else {
            var arr = [];
            for (const v of value) {
                let mapped;
                if(attributes[key]["type"] === 'media') {
                    mapped = fileIdToDbId.getMapping('plugin::upload.file', v);
                } else {
                    mapped = fileIdToDbId.getMapping((attributes[key] as any)["target"], v);
                }
                if (mapped) {
                    arr.push(mapped);
                } else {
                    arr.push(v);
                }
            }
            fileEntry[key] = arr;
        }
    }
}

