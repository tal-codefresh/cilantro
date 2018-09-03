const
    _ = require('lodash'),
    fp = require('lodash/fp'),
    kefir = require('kefir'),
    concat = require('concat-stream'),
    tarStream = require('tar-stream'),
    hydrophonic = require('hydrophonic');

const [
    codefreshYaml = [],
    workflowDefinition = {}
] = ["WORKFLOW_DEFINITION_STEPS", "WORKFLOW_DEFINITION_CONTEXT"].map(_.partial(_.attempt, (varName)=> JSON.parse(process.env[varName]))).filter(_.negate(_.isError))

const TARRAGON_IMAGE = "codefresh/tarragon:latest";

let dockerClient = hydrophonic({
    ..._(workflowDefinition).chain().get('environmentCertificates').pick('ca', 'cert', 'key').value(),
    url: ["https:", _.at(workflowDefinition, ["dockerNode.ip", "dockerNode.port"]).join(':')].join('//')
});

let workJsonTarProperty = kefir.fromCallback((cb)=>{
    let packStream = tarStream.pack();
    packStream.entry({ name: "work.json" }, Buffer.from(JSON.stringify({ steps: codefreshYaml }), 'utf8'));
    packStream.finalize();
    packStream.pipe(concat(cb));
});


kefir
    .concat([
        dockerClient.pullImage({ id: TARRAGON_IMAGE }),
        dockerClient
            .createContainer({ image: TARRAGON_IMAGE, cmd: ["work.json", "--output=metalog"] })
            .combine(workJsonTarProperty)
            .flatMap(([containerId, workJsonTar])=> {
                return kefir.concat([
                    (function({ write, end, output }){
                        write(workJsonTar);
                        end();
                        return output;
                    })(dockerClient.copyToContainer({ containerId, path: "/app" })).ignoreValues(),
                    (function(containerStream){
                        return kefir.merge([
                            containerStream,
                            containerStream.take(1).flatMap(()=>  dockerClient.startContainer({ id: containerId })).ignoreValues()
                        ]);
                    })(dockerClient.attachContainer({ id: containerId }))
                ]);
            }),
    ])
    .filter(fp.matches({ "type": "body" }))
    .map(fp.pipe(fp.get('payload'), fp.toString))
    .log();
