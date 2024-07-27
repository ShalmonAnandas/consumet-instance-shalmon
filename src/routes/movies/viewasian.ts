import { FastifyRequest, FastifyReply, FastifyInstance, RegisterOptions } from 'fastify';
import { MOVIES } from '@consumet/extensions';
import { IMovieResult, ISearch, StreamingServers } from '@consumet/extensions/dist/models';
import axios from 'axios';

const routes = async (fastify: FastifyInstance, options: RegisterOptions) => {
  const viewAsian = new MOVIES.ViewAsian();

  async function getBase64ImageFromUrl(imageUrl: string): Promise<string | null> {
    try {
      const image = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(image.data, 'binary');
      const base64Image = buffer.toString('base64');
      return `data:image/jpeg;base64,${base64Image}`;
    } catch (error) {
      console.error('Error fetching image:', error);
      return null;
    }
  }

  async function updateMoviesWithBase64ImagesForSearch(movies: ISearch<IMovieResult>): Promise<ISearch<IMovieResult>> {
    const updatedMovies = await Promise.all(movies.results.map(async (movie) => {
      const base64Image = await getBase64ImageFromUrl(movie.image!);
      return { ...movie, base64Image };
    }));
    movies["results"] = updatedMovies;
    return movies;
  }

  fastify.get('/', (_, rp) => {
    rp.status(200).send({
      intro:
        "Welcome to the viewAsian provider: check out the provider's website @ https://viewAsian.to/",
      routes: ['/:query', '/info', '/watch'],
      documentation: 'https://docs.consumet.org/#tag/viewAsian',
    });
  });

  fastify.get('/:query', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = decodeURIComponent((request.params as { query: string }).query);

    const page = (request.query as { page: number }).page;

    const res = await viewAsian.search(query, page);

    let updatedResults = await updateMoviesWithBase64ImagesForSearch(res);

    reply.status(200).send(updatedResults);
  });

  fastify.get('/info', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = (request.query as { id: string }).id;

    if (typeof id === 'undefined')
      return reply.status(400).send({
        message: 'id is required',
      });

    try {
      const res = await viewAsian
        .fetchMediaInfo(id)
        .catch((err) => reply.status(404).send({ message: err }));

      let updatedImage = await getBase64ImageFromUrl(res.image!);
      res.image = updatedImage!;

      let updatedCover = await getBase64ImageFromUrl(res.cover!);
      res.cover = updatedCover!;

      reply.status(200).send(res);
    } catch (err) {
      reply.status(500).send({
        message:
          'Something went wrong. Please try again later. or contact the developers.',
      });
    }
  });

  fastify.get('/watch', async (request: FastifyRequest, reply: FastifyReply) => {
    const episodeId = (request.query as { episodeId: string }).episodeId;
    const server = (request.query as { server: StreamingServers }).server;

    if (typeof episodeId === 'undefined')
      return reply.status(400).send({ message: 'episodeId is required' });

    if (server && !Object.values(StreamingServers).includes(server))
      return reply.status(400).send({ message: 'Invalid server query' });

    try {
      const res = await viewAsian
        .fetchEpisodeSources(episodeId, server)
        .catch((err) => reply.status(404).send({ message: 'Media Not found.' }));

      reply.status(200).send(res);
    } catch (err) {
      reply
        .status(500)
        .send({ message: 'Something went wrong. Please try again later.' });
    }
  });
};

export default routes;
