import { assoc, dissoc, invertObj, map, pipe, propOr, filter } from 'ramda';
import { v4 as uuidv4 } from 'uuid';
import { delEditContext, notify, setEditContext } from '../database/redis';
import {
  createEntity,
  createRelation,
  createRelations,
  deleteEntityById,
  deleteRelationById,
  deleteRelationsByFromAndTo,
  escape,
  escapeString,
  executeWrite,
  findWithConnectedRelations,
  listEntities,
  loadEntityById,
  loadRelationById,
  now,
  timeSeriesEntities,
  updateAttribute,
} from '../database/grakn';
import { BUS_TOPICS, logger } from '../config/conf';
import { elCount } from '../database/elasticSearch';
import { buildPagination, INDEX_STIX_CYBER_OBSERVABLES } from '../database/utils';
import { createWork, workToExportFile } from './work';
import { pushToConnector } from '../database/rabbitmq';
import { addIndicator } from './indicator';
import { askEnrich } from './enrichment';
import { ForbiddenAccess, FunctionalError } from '../config/errors';
import { createStixPattern } from '../python/pythonBridge';
import { checkObservableSyntax } from '../utils/syntax';
import { connectorsForExport } from './connector';
import { findById as findMarkingDefinitionById } from './markingDefinition';
import { generateFileExportName, upload } from '../database/minio';
import stixCyberObservableResolvers from '../resolvers/stixCyberObservable';
import {
  ABSTRACT_STIX_CYBER_OBSERVABLE,
  ABSTRACT_STIX_DOMAIN_OBJECT,
  ABSTRACT_STIX_META_RELATIONSHIP,
  ENTITY_AUTONOMOUS_SYSTEM,
  ENTITY_DIRECTORY,
  ENTITY_EMAIL_MESSAGE,
  ENTITY_EMAIL_MIME_PART_TYPE,
  ENTITY_HASHED_OBSERVABLE_ARTIFACT,
  ENTITY_HASHED_OBSERVABLE_STIX_FILE,
  ENTITY_HASHED_OBSERVABLE_X509_CERTIFICATE,
  ENTITY_MUTEX,
  ENTITY_NETWORK_TRAFFIC,
  ENTITY_PROCESS,
  ENTITY_SOFTWARE,
  ENTITY_TYPE_CONNECTOR,
  ENTITY_USER_ACCOUNT,
  ENTITY_WINDOWS_REGISTRY_KEY,
  ENTITY_WINDOWS_REGISTRY_VALUE_TYPE,
  ENTITY_X509_V3_EXTENSIONS_TYPE,
  isStixCyberObservable,
  isStixCyberObservableHashedObservable,
  isStixMetaRelationship,
  RELATION_OBJECT,
} from '../utils/idGenerator';

export const findById = (stixCyberObservableId) => {
  return loadEntityById(stixCyberObservableId, ABSTRACT_STIX_CYBER_OBSERVABLE);
};

export const findAll = async (args) => {
  let types = [];
  if (args.types && args.types.length > 0) {
    types = filter((type) => isStixCyberObservable(type), args.types);
  }
  if (types.length === 0) {
    types.push(ABSTRACT_STIX_CYBER_OBSERVABLE);
  }
  return listEntities(types, ['standard_id'], args);
};

// region by elastic
export const stixCyberObservablesNumber = (args) => ({
  count: elCount(INDEX_STIX_CYBER_OBSERVABLES, args),
  total: elCount(INDEX_STIX_CYBER_OBSERVABLES, dissoc('endDate', args)),
});
// endregion

// region time series
export const reportsTimeSeries = (stixCyberObservableId, args) => {
  const filters = [{ isRelation: true, type: RELATION_OBJECT, value: stixCyberObservableId }];
  return timeSeriesEntities('Report', filters, args);
};

export const stixCyberObservablesTimeSeries = (args) => {
  return timeSeriesEntities(args.type ? escape(args.type) : ABSTRACT_STIX_CYBER_OBSERVABLE, [], args);
};
// endregion

// region mutations
export const stixCyberObservableAskEnrichment = async (id, connectorId) => {
  const connector = await loadEntityById(connectorId, ENTITY_TYPE_CONNECTOR);
  const { job, work } = await createWork(connector, ABSTRACT_STIX_CYBER_OBSERVABLE, id);
  const message = {
    work_id: work.internal_id,
    job_id: job.internal_id,
    entity_id: id,
  };
  await pushToConnector(connector, message);
  return work;
};

export const indicators = (stixCyberObservableId) => {
  // TODO
  return null;
};

export const observableValue = (stixCyberObservable) => {
  switch (stixCyberObservable.entity_type) {
    case ENTITY_AUTONOMOUS_SYSTEM:
      return stixCyberObservable.number;
    case ENTITY_DIRECTORY:
      return stixCyberObservable.path;
    case ENTITY_EMAIL_MESSAGE:
      return stixCyberObservable.body || stixCyberObservable.subject;
    case ENTITY_EMAIL_MIME_PART_TYPE:
      return stixCyberObservable.body;
    case ENTITY_HASHED_OBSERVABLE_ARTIFACT:
      return (
        stixCyberObservable.md5 ||
        stixCyberObservable.sha1 ||
        stixCyberObservable.sha256 ||
        stixCyberObservable.sha512 ||
        stixCyberObservable.payload_bin
      );
    case ENTITY_HASHED_OBSERVABLE_STIX_FILE:
      return (
        stixCyberObservable.md5 ||
        stixCyberObservable.sha1 ||
        stixCyberObservable.sha256 ||
        stixCyberObservable.sha512 ||
        stixCyberObservable.name
      );
    case ENTITY_HASHED_OBSERVABLE_X509_CERTIFICATE:
      return stixCyberObservable.subject || stixCyberObservable.issuer;
    case ENTITY_MUTEX:
      return stixCyberObservable.name;
    case ENTITY_NETWORK_TRAFFIC:
      return stixCyberObservable.dst_port;
    case ENTITY_PROCESS:
      return stixCyberObservable.pid;
    case ENTITY_SOFTWARE:
      return stixCyberObservable.name;
    case ENTITY_USER_ACCOUNT:
      return stixCyberObservable.account_login;
    case ENTITY_WINDOWS_REGISTRY_KEY:
      return stixCyberObservable.attribute_key;
    case ENTITY_WINDOWS_REGISTRY_VALUE_TYPE:
      return stixCyberObservable.name;
    case ENTITY_X509_V3_EXTENSIONS_TYPE:
      return stixCyberObservable.certificate_policies;
    default:
      return stixCyberObservable.value;
  }
};

export const addStixCyberObservable = async (user, args) => {
  if (!isStixCyberObservable(args.type)) {
    throw FunctionalError(`Observable type ${args.type} is not supported.`);
  }
  const graphQLType = args.type.replace(/(?:^|-|_)(\w)/g, (matches, letter) => letter.toUpperCase());
  if (!args[graphQLType]) {
    throw FunctionalError(`Expecting variable ${graphQLType} in the input, got nothing.`);
  }
  const observableSyntaxResult = checkObservableSyntax(args.type, args);
  if (observableSyntaxResult !== true) {
    throw FunctionalError(`Observable of type ${args.type} is not correctly formatted.`, { observableSyntaxResult });
  }
  const created = await createEntity(user, args[graphQLType], args.type);
  await askEnrich(created.id, args.type);
  // create the linked indicator
  if (args.createIndicator) {
    try {
      let entityType = created.entity_type;
      if (entityType === 'StixFile') {
        entityType = 'File';
      }
      let key = entityType;
      if (isStixCyberObservableHashedObservable(created.entity_type)) {
        if (created.sha256) {
          key = `${entityType}_sha256`;
        } else if (created.sha1) {
          key = `${entityType}_sha1`;
        } else if (created.md5) {
          key = `${entityType}_md5`;
        }
      }
      const pattern = await createStixPattern(key, observableValue(created));
      if (pattern) {
        const indicatorToCreate = pipe(
          dissoc('internal_id'),
          dissoc('stix_id'),
          dissoc('observable_value'),
          assoc('name', observableValue(created)),
          assoc('description', `Simple indicator of observable {${observableValue(created)}}`),
          assoc('pattern_type', 'stix'),
          assoc('pattern', pattern),
          assoc('x_opencti_main_observable_type', created.entity_type),
          assoc('basedOn', [created.id])
        )(args[graphQLType]);
        await addIndicator(user, indicatorToCreate, false);
      }
    } catch (err) {
      logger.info(`Cannot create indicator`, { error: err });
    }
  }
  return notify(BUS_TOPICS[ABSTRACT_STIX_CYBER_OBSERVABLE].ADDED_TOPIC, created, user);
};

export const stixCyberObservableDelete = async (user, stixCyberObservableId) => {
  return deleteEntityById(user, stixCyberObservableId, ABSTRACT_STIX_CYBER_OBSERVABLE);
};

export const stixCyberObservableAddRelation = async (user, stixCyberObservableId, input) => {
  const stixCyberObservable = await loadEntityById(stixCyberObservableId, ABSTRACT_STIX_DOMAIN_OBJECT);
  if (!stixCyberObservable) {
    throw FunctionalError('Cannot add the relation, Stix-Domain-Object cannot be found.');
  }
  if (!isStixMetaRelationship(input.relationship_type)) {
    throw FunctionalError(`Only ${ABSTRACT_STIX_META_RELATIONSHIP} can be added through this method.`);
  }
  const finalInput = assoc('fromId', stixCyberObservableId, input);
  return createRelation(user, finalInput).then((relationData) => {
    notify(BUS_TOPICS[ABSTRACT_STIX_DOMAIN_OBJECT].EDIT_TOPIC, relationData, user);
    return relationData;
  });
};

export const stixCyberObservableAddRelations = async (user, stixCyberObservableId, input) => {
  const stixCyberObservable = await loadEntityById(stixCyberObservableId, ABSTRACT_STIX_CYBER_OBSERVABLE);
  if (!stixCyberObservable) {
    throw FunctionalError('Cannot add the relation, Stix-Cyber-Observable cannot be found.');
  }
  if (!isStixMetaRelationship(input.relationship_type)) {
    throw FunctionalError(`Only ${ABSTRACT_STIX_META_RELATIONSHIP} can be added through this method.`);
  }
  const finalInput = map(
    (n) => ({ fromId: stixCyberObservableId, toId: n, relationship_type: input.relationship_type }),
    input.toIds
  );
  await createRelations(user, finalInput);
  return loadEntityById(stixCyberObservableId, ABSTRACT_STIX_CYBER_OBSERVABLE).then((entity) =>
    notify(BUS_TOPICS[ABSTRACT_STIX_CYBER_OBSERVABLE].EDIT_TOPIC, entity, user)
  );
};

export const stixCyberObservableDeleteRelation = async (user, stixCyberObservableId, toId, relationshipType) => {
  const stixCyberObservable = await loadEntityById(stixCyberObservableId, ABSTRACT_STIX_CYBER_OBSERVABLE);
  if (!stixCyberObservable) {
    throw FunctionalError('Cannot delete the relation, Stix-Cyber-Observable cannot be found.');
  }
  if (!isStixMetaRelationship(relationshipType)) {
    throw FunctionalError(`Only ${ABSTRACT_STIX_META_RELATIONSHIP} can be deleted through this method.`);
  }
  await deleteRelationsByFromAndTo(
    user,
    stixCyberObservableId,
    toId,
    relationshipType,
    ABSTRACT_STIX_META_RELATIONSHIP
  );
  return notify(BUS_TOPICS[ABSTRACT_STIX_CYBER_OBSERVABLE].EDIT_TOPIC, stixCyberObservable, user);
};

export const stixCyberObservableEditField = (user, stixCyberObservableId, input) => {
  return executeWrite((wTx) => {
    return updateAttribute(user, stixCyberObservableId, ABSTRACT_STIX_CYBER_OBSERVABLE, input, wTx);
  }).then(async () => {
    const stixCyberObservable = await loadEntityById(stixCyberObservableId, ABSTRACT_STIX_CYBER_OBSERVABLE);
    return notify(BUS_TOPICS.StixCyberObservable.EDIT_TOPIC, stixCyberObservable, user);
  });
};
// endregion

// region context
export const stixCyberObservableCleanContext = (user, stixCyberObservableId) => {
  delEditContext(user, stixCyberObservableId);
  return loadEntityById(stixCyberObservableId, ABSTRACT_STIX_CYBER_OBSERVABLE).then((stixCyberObservable) =>
    notify(BUS_TOPICS[ABSTRACT_STIX_CYBER_OBSERVABLE].EDIT_TOPIC, stixCyberObservable, user)
  );
};

export const stixCyberObservableEditContext = (user, stixCyberObservableId, input) => {
  setEditContext(user, stixCyberObservableId, input);
  return loadEntityById(stixCyberObservableId, ABSTRACT_STIX_CYBER_OBSERVABLE).then((stixCyberObservable) =>
    notify(BUS_TOPICS[ABSTRACT_STIX_CYBER_OBSERVABLE].EDIT_TOPIC, stixCyberObservable, user)
  );
};
// endregion

// region export
const askJobExports = async (
  format,
  entity = null,
  exportType = null,
  maxMarkingDefinition = null,
  context = null,
  listArgs = null
) => {
  const connectors = await connectorsForExport(format, true);
  // Create job for every connectors
  const haveMarking = maxMarkingDefinition && maxMarkingDefinition.length > 0;
  const maxMarkingDefinitionEntity = haveMarking ? await findMarkingDefinitionById(maxMarkingDefinition) : null;
  const workList = await Promise.all(
    map((connector) => {
      const fileName = generateFileExportName(
        format,
        connector,
        entity,
        'stix-observable',
        exportType,
        maxMarkingDefinitionEntity
      );
      return createWork(connector, 'stix-observable', entity ? entity.id : null, context, fileName).then(
        ({ work, job }) => ({
          connector,
          job,
          work,
        })
      );
    }, connectors)
  );
  let finalListArgs = listArgs;
  if (listArgs !== null) {
    const stixCyberObservablesFiltersInversed = invertObj(stixCyberObservableResolvers.StixCyberObservablesFilter);
    const stixCyberObservablesOrderingInversed = invertObj(stixCyberObservableResolvers.StixCyberObservablesOrdering);
    finalListArgs = pipe(
      assoc(
        'filters',
        map(
          (n) => ({
            key: n.key in stixCyberObservablesFiltersInversed ? stixCyberObservablesFiltersInversed[n.key] : n.key,
            values: n.values,
          }),
          propOr([], 'filters', listArgs)
        )
      ),
      assoc(
        'orderBy',
        listArgs.orderBy in stixCyberObservablesOrderingInversed
          ? stixCyberObservablesOrderingInversed[listArgs.orderBy]
          : listArgs.orderBy
      )
    )(listArgs);
  }
  // Send message to all correct connectors queues
  await Promise.all(
    map((data) => {
      const { connector, job, work } = data;
      const message = {
        work_id: work.internal_id, // work(id)
        job_id: job.internal_id, // job(id)
        max_marking_definition: maxMarkingDefinition && maxMarkingDefinition.length > 0 ? maxMarkingDefinition : null, // markingDefinition(id)
        export_type: exportType, // for entity, simple or full / for list, withArgs / withoutArgs
        entity_type: 'stix-observable',
        entity_id: entity ? entity.id : null, // report(id), thread(id), ...
        list_args: finalListArgs,
        file_context: work.work_context,
        file_name: work.work_file, // Base path for the upload
      };
      return pushToConnector(connector, message);
    }, workList)
  );
  return workList;
};
// endregion

// region mutation
/**
 * Create export element waiting for completion
 * @param args
 * @returns {*}
 */
export const stixCyberObservableExportAsk = async (args) => {
  const { format, stixCyberObservableId = null, exportType = null, maxMarkingDefinition = null, context = null } = args;
  const entity = stixCyberObservableId
    ? await loadEntityById(stixCyberObservableId, ABSTRACT_STIX_CYBER_OBSERVABLE)
    : null;
  const workList = await askJobExports(format, entity, exportType, maxMarkingDefinition, context, args);
  // Return the work list to do
  return map((w) => workToExportFile(w.work), workList);
};

export const stixCyberObservableImportPush = (user, entityType = null, entityId = null, file) => {
  return upload(user, 'import', file, entityType, entityId);
};

export const stixCyberObservableExportPush = async (user, entityId = null, file, context = null, listArgs = null) => {
  // Upload the document in minio
  await upload(user, 'export', file, 'stix-observable', entityId, context, listArgs);
  return true;
};
