const { exec } = require('child_process');
const path = require('path');

exports.mochaGlobalSetup = async function () {
  process.env.NODE_CONFIG_DIR = path.join(__dirname, '../../config');

  const prom = () =>
    new Promise(resolve =>
      exec(
        `cd 'test/deploy-contracts' && npx --yes truffle migrate --to 2 --network=localhost`,
        (error, stdout, stderr) => {
          console.log(stdout);
          console.log(stderr);
          resolve();
          if (error !== null) console.log('exec error:', error);
        },
      ),
    );

  await prom();
};
