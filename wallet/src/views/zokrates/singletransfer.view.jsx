import React, { useEffect, useState } from 'react';
import { initialize } from 'zokrates-js';

// eslint-disable-next-line
import abi from './single_transfer/artifacts/single_transfer-abi.json';
// eslint-disable-next-line
import programFile from './single_transfer/artifacts/single_transfer-program';
// eslint-disable-next-line
import pkFile from './single_transfer/keypair/single_transfer-pk';
import { parseData, mergeUint8Array } from '../../utils/lib/file-reader-utils';

export default function Zokrates() {
  const [proof, setProof] = useState('');

  useEffect(async () => {
    const zokratesProvider = await initialize();
    const program = await fetch(programFile)
      .then(response => response.body.getReader())
      .then(parseData)
      .then(mergeUint8Array);
    const pk = await fetch(pkFile)
      .then(response => response.body.getReader())
      .then(parseData)
      .then(mergeUint8Array);

    const artifacts = { program: new Uint8Array(program), abi: JSON.stringify(abi) };
    const keypair = { pk: new Uint8Array(pk) };

    const witnessInput = [
      '1372267967327876207394531437215731016851360150467',
      {
        id: ['0', '0', '0', '0', '0', '0', '0', '0'],
        value: ['0', '0', '0', '0', '0', '0', '0', '1000000000'],
        salt: [
          '3497914804',
          '2058663549',
          '3993229573',
          '3092771665',
          '2343436585',
          '4008803050',
          '1975304704',
          '1870736686',
        ],
        hash: [
          '80928920',
          '2522573003',
          '957990451',
          '4054002880',
          '4039834529',
          '1547373129',
          '318562705',
          '3498654229',
        ],
        ask: '19050095353191019700969450004869055325131771711696244913992973653858825392990',
      },
      {
        pkdRecipient: [
          '607135818944138260287990112473434770207001680477301611406176502210626228896',
          '6203326404641991894455027203313092664539747393780465415363638529404812790512',
        ],
        value: ['0', '0', '0', '0', '0', '0', '0', '1000000000'],
        salt: [
          '674551115',
          '3337123061',
          '3333898573',
          '1780863689',
          '3020049766',
          '3528691700',
          '1750320020',
          '1407507198',
        ],
      },
      '2455583074113660779903385312653820772669067913896373634769119560924397282162',
      [
        '110986205',
        '1583089169',
        '4034709162',
        '1735821690',
        '4092586133',
        '1053991356',
        '3192463729',
        '790982480',
      ],
      '357055550426312649620430456950070443103087141275897004438006417083739150850',
      '1815620890523359005508532967121243518907326005319635701927084780753943438261',
      [
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '0',
        '9099494177718611132969532090259439967090162160789474874430926841903203984098',
        '16187223803040830990317680253792159598369031360199439017503881119128940036367',
      ],
      '2',
      {
        ephemeralKey1: [
          '2925523678',
          '993219490',
          '91487875',
          '3493554650',
          '2778297815',
          '1502578320',
          '2122438320',
          '3859857217',
        ],
        ephemeralKey2: [
          '3805184739',
          '4280987785',
          '436386018',
          '1291433834',
          '1042994525',
          '1917852607',
          '255072540',
          '3541608803',
        ],
        ephemeralKey3: [
          '3848400218',
          '423994712',
          '2780111460',
          '2140349048',
          '612218752',
          '709214002',
          '1316293745',
          '3287335275',
        ],
        ephemeralKey4: [
          '3357476783',
          '385762224',
          '2475554597',
          '3249757242',
          '2437566341',
          '3974421737',
          '3525142364',
          '1670858631',
        ],
        cipherText: [
          '673119077154386773048932337929721440004804809494174008531837919601926202755',
          '4562267891791913612651710403614952415497875644071153288984759586801424589789',
          '9127610960432865822641609503890962920584062433907854744032417582884317108079',
          '1200986982689990442418122443950985496860363902692720441800438229253181297450',
          '1887103771142529307563543278421122918643923913189458637072013542577431806404',
          '4922090671858897570467579007346589661820877655887801720275988266733866979148',
          '4724695462175702002479614382051639564920267478195874973797257417573576879524',
          '20676255077837827119468195014858565663366332098283070635397782013580451188620',
          '7328603336263607573839867808840124784031059948004130821831993545237148470721',
          '2820365561033989539468672304168716353850344470537607269375021691809007834464',
          '16463363278938047565884989046248652380439040843389459614818846997931854247199',
          '8204715096359696997600565029682185410100467439413505862359665551255558631626',
          '1592935235292859030382536761611000938091365356314531075402846715972026908516',
          '9983294570548572813987059939384092180828492184362646376539269798798854365209',
          '17786997208980270927710956559295876426962323795105990929648496949622248563203',
          '13663915086910777905818159099879293693712201105289579780979032645287260322830',
        ],
        sqrtMessage1:
          '3235064184807591309652880672332362654741145755388127732110797917184204297979',
        sqrtMessage2: '0',
        sqrtMessage3:
          '2287744532831249441982619566754567414675899488410820637757670451088858932601',
        sqrtMessage4:
          '1119320251512181733761693150807266752626644461911891554221066604346139732535',
      },
      [
        '39139405959249728918468801713081014979516868069568756193447711492317963229',
        '296361285523457665671474123570611216756692147492403535242175854191359972138',
        '398962186026233686734337405444718261302518879886217187484676391424760352588',
        '322176891590839642668607806300144361033717606275940237836878574689471369100',
        '106488469534391209228727343027593513539329204936656549700234566623543858528',
        '63083821860902006880730146258816889167421642610653703335304175699166703818',
        '32411901716712269773928415199975099688102877159160404398383673118819786777',
        '94529629412786254618434294173679492157124777284826182605097019359940443150',
      ],
    ];
    // computation
    const { witness } = zokratesProvider.computeWitness(artifacts, witnessInput);

    // generate proof
    const genProof = zokratesProvider.generateProof(artifacts.program, witness, keypair.pk);

    setProof(JSON.stringify(genProof, 2, 2));
  }, []);

  return (
    <div>
      <span>Single transfer work beigin</span>
      <p>{proof}</p>
    </div>
  );
}
