// GET /orders/web-check — an ordinary (event) Lambda calling the orders-web
// web function through the URL its environment carries.
//
// ORDERS_WEB_URL is declared in serverless.yml as
// `https://` + `Fn::GetAtt OrdersWebEndpoint.DomainName`: on AWS, the endpoint's
// managed HTTPS domain. Locally LSS resolves DomainName to the endpoint's stable
// port (`localhost:<port>`) and rewrites the scheme to http, so this exact code
// reaches the local web function.
exports.handler = async () => {
  const url = process.env.ORDERS_WEB_URL;
  const started = Date.now();
  const response = await fetch(`${url}/api/health`);
  const body = await response.json();
  return {
    statusCode: 200,
    body: JSON.stringify({
      calledUrl: url,
      status: response.status,
      requestId: response.headers.get('lambda-web-request-id'),
      elapsedMs: Date.now() - started,
      webFunction: body,
    }),
  };
};
